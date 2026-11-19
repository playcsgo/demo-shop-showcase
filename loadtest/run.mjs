#!/usr/bin/env node
// 壓測：跑完產生 run.json 和報告（loadtest/report）
//
//   node loadtest/run.mjs --change "庫存 1 桶 → 8 桶" --buckets 8 [--baseline ../tests/<基準的資料夾>]
//
//   --mode       dev-container（舊名 sandbox）：docker compose 第 1 套（開跑前重新 build、部署；每個服務 1 個容器）
//                k8s-single：每個服務固定 1 個 Pod｜k8s-auto（預設）：HPA＋KEDA 自己擴
//                k8s-max：開跑前直接開到上限｜k8s-fixed4：每個服務固定 4 個 Pod
//   --logistics-callbacks off  物流不回傳狀態（已收件→配送中→送達）：測試的終點是「交給物流」，狀態回呼只會佔住 core 的回程佇列
//   --direct-only  只買直送商品（量訂單流程本身；預設是 70% 直送、15% 寄倉、15% 預約）
//   --change     這一輪改了什麼（基準不填）。資料夾名稱由設定自動產生（loadtest/naming.mjs），這裡只是附在後面的說明
//   --buckets    庫存分幾桶（預設 1）
//   --levels     每一階的每秒下單數（預設 20,40,60,80,100）；查詢同時打，是下單的 --ratio 倍（預設 20；0＝不打查詢）
//   --ramp/--hold  每一階爬升／維持幾秒（預設 15／40）；--idle 低流量基準幾秒（預設 180）
//   --worlds     perfect,realistic（預設兩個都跑）
//   --baseline   跟哪一輪比（某一輪的資料夾或 run.json）
//   --out        結果放哪裡（預設 repo 旁邊的 ../tests：報告不進 repo）
//
// 每個世界：重建環境 → 套用廠商設定 → 切換模式（Pod 數）→ 取樣＋k6 → 等消化完 → 不變式 → Loki 算 pay_e2e → 還原模式
// 例：微服務處理速度（完美世界、只買直送、不打查詢）
//   node loadtest/run.mjs --mode dev-container --worlds perfect --direct-only --ratio 0 --levels 5,10,20 --change "dev-container 基準"
// 要獨佔這台電腦：壓測量的是真實的處理能力，旁邊有別的東西在跑，數字就不準
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { payE2e, saturationIn, timeseries, windows } from './collect/aggregate.mjs';
import * as k8sAdapter from './collect/k8s.mjs';
import * as sandboxAdapter from './collect/sandbox.mjs';
import { runId } from './naming.mjs';
import { renderHtml } from './report/html.mjs';
import { render } from './report/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: o } = parseArgs({
  options: {
    mode: { type: 'string', default: 'k8s-auto' },
    'direct-only': { type: 'boolean', default: false },
    'logistics-callbacks': { type: 'string', default: 'on' },
    change: { type: 'string' },
    buckets: { type: 'string', default: '1' },
    levels: { type: 'string', default: '20,40,60,80,100' },
    ratio: { type: 'string', default: '20' },
    ramp: { type: 'string', default: '15' },
    hold: { type: 'string', default: '40' },
    idle: { type: 'string', default: '180' },
    worlds: { type: 'string', default: 'perfect,realistic' },
    seed: { type: 'string', default: '42' },
    'max-vus': { type: 'string', default: '2000' },
    baseline: { type: 'string' },
    out: { type: 'string', default: join(ROOT, '..', 'tests') },
  },
});
o.mode = o.mode === 'sandbox' ? 'dev-container' : k8sAdapter.modeName(o.mode);   // 舊的名字 sandbox、k8s-autoscale、k8s-prepared 也接受
const MODES = { ...sandboxAdapter.MODES, ...k8sAdapter.MODES };
if (!MODES[o.mode]) throw new Error(`--mode 只能是 ${Object.keys(MODES).join('、')}：${o.mode}`);
// 同一組函式（reset、sample、runK6…），環境不同
const k8s = o.mode === 'dev-container' ? sandboxAdapter : k8sAdapter;

const LEVELS = o.levels.split(',').map(Number);
const RATIO = Number(o.ratio);
const MAX_VUS = Number(o['max-vus']);
// 每個虛擬客人一個帳號：levels.js 的 maxVUs 加總（低流量 20＋50，每一階下單、查詢各 MAX_VUS）
const CUSTOMERS = 70 + LEVELS.length * 2 * MAX_VUS;

// 資料夾名稱：本地時間＋從實際設定產生的名稱＋說明（loadtest/naming.mjs）；不靠手打，名稱和設定就不會對不上
// PHP 執行方式（FPM／Octane）從叢集讀，不是參數：部署的是哪一種就是哪一種
const RUNTIME = await k8s.runtime();
const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).replace(/[-:]/g, '').replace(' ', '-').slice(0, 13);
const id = runId(stamp, { mode: o.mode, worlds: o.worlds, buckets: Number(o.buckets), logisticsCallbacks: o['logistics-callbacks'] !== 'off', runtime: RUNTIME, levels: o.levels, directOnly: o['direct-only'], ratio: RATIO }, o.change);
const dir = join(o.out, id);
mkdirSync(dir, { recursive: true });
const logLines = [];
const log = (msg) => { const line = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${msg}`; console.log(line); logLines.push(line); };

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '（有未 commit 的修改）' : '');

const run = {
  schema: 1,
  meta: {
    id, startedAt: new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16), commit, seed: Number(o.seed), mode: o.mode, runtime: RUNTIME,
    change: o.change ?? null,
    catalog: o['direct-only'] ? '只買直送：9 個直送商品，全站搶同一批貨' : '搶購：11 個商品（9 直送＋寄倉飼料＋健檢），全站搶同一批貨',
    directOnly: o['direct-only'],
    logisticsCallbacks: o['logistics-callbacks'] !== 'off',
    buckets: Number(o.buckets), dbReset: true,
    idle: { order: 1, query: RATIO, holdSec: Number(o.idle) },
    queryRatio: RATIO,
    levels: { order: LEVELS, query: LEVELS.map((x) => x * RATIO) },
    rampSec: Number(o.ramp), holdSec: Number(o.hold),
    env: await k8s.environment(),
  },
  worlds: {},
};

// dev-container：先重新部署（程式改過就重新 build），整段時間持有這一套的鎖
const releaseSet = k8s.deploy ? await k8s.deploy(log) : () => {};
run.meta.datadog = await k8s.datadog();
if (run.meta.datadog.apm) log('⚠️ Datadog APM trace 開著：trace 本身很吃 CPU，數字會偏慢（dev-container：scripts/sandbox.sh datadog 1 all --no-apm；K8s：.env 的 DATA_DOG_APM=FALSE 再跑 bootstrap）');
else if (run.meta.datadog.metrics) log(`Datadog：只送指標（env ${run.meta.datadog.env}），APM 關`);
else log('⚠️ Datadog 沒開：這一輪的數字只在報告裡，Datadog 上看不到（dev-container：scripts/sandbox.sh datadog 1 all --no-apm；K8s：.env 的 DATA_DOG=TRUE 再跑 bootstrap）');
const tunnel = await k8s.lokiTunnel();
try {
  for (const world of o.worlds.split(',')) {
    log(`══════ ${world === 'perfect' ? '完美世界' : '真實世界'} ══════`);
    await k8s.reset({ customers: CUSTOMERS, buckets: run.meta.buckets, log });
    await k8s.partners('POST', `/admin/presets/${world}`);
    if (o['logistics-callbacks'] === 'off') {
      const after = await k8s.partners('PUT', '/admin/settings', { logistics: { statusCallbacks: 'off' } });
      // 舊版 partners 不認識這個設定，會直接忽略：報告寫「關」、物流卻照樣回呼。沒生效就停下來
      if (after.logistics?.statusCallbacks !== 'off') throw new Error('partners 不支援關掉物流狀態回呼（image 太舊）：K8s 先「重新部署 K8s」，dev-container 會在開跑時自動重新部署');
      log('物流狀態回呼：關（只到交給物流）');
    }
    const { settings } = await k8s.partners('GET', '/admin/state');
    const restore = await k8s.prepareMode(o.mode, log);
    try {
      const sampler = k8s.startSampler({ log });
      let k6;
      try {
        k6 = await k8s.runK6({ ORDER_LEVELS: o.levels, QUERY_RATIO: RATIO, RAMP: o.ramp, HOLD: o.hold, IDLE: o.idle, IDLE_ORDER: 1, MAX_VUS, SEED: o.seed, DIRECT_ONLY: o['direct-only'] ? 1 : 0 }, { root: ROOT, log });
      } finally {
        await sampler.stop();
      }
      log(`k6 結束，取樣 ${sampler.samples.length} 筆${sampler.errors.length ? `（失敗 ${sampler.errors.length} 次）` : ''}`);
      const drained = await k8s.drain({ log });
      log(drained.seconds == null ? '⚠️ 15 分鐘內沒消化完' : `消化完（${drained.seconds} 秒）`);
      const inv = await k8s.invariants();
      log(`不變式：${inv.every((i) => i.pass) ? '全過' : `${inv.filter((i) => !i.pass).length} 項沒過`}`);

      const wins = windows(k6.t0, k6.result);
      const e2e = await payE2e(tunnel.url, wins, Date.now());
      const orders = await k8s.orderCount();
      const byLvl = Object.fromEntries(k6.result.levels.map((l) => [l.lvl, l]));
      const level = (w) => {
        const k = byLvl[w.lvl];
        return {
          target: k.target, achieved: k.achieved, dropped: k.dropped, droppedQuery: k.droppedQuery, success: k.success,
          query: k.query, pay_api: k.pay_api, steps: k.steps, ...e2e.perWindow[w.lvl],
          sat: saturationIn(sampler.samples, w),
        };
      };
      const idleWin = wins.find((w) => w.lvl === 'idle');
      run.worlds[world] = {
        partnerSettings: settings,
        idle: idleWin ? (({ query, pay_api, pay_e2e, steps }) => ({ query, pay_api, pay_e2e, steps }))(level(idleWin)) : null,
        levels: wins.filter((w) => w.lvl !== 'idle').map(level),
        correctness: { invariants: inv },
        drainSeconds: drained.seconds,
        logCoverage: { lokiPlaced: e2e.placedInLoki, dbOrders: orders },
        samplerErrors: sampler.errors.length,
        timeseries: timeseries(sampler.samples, wins.find((w) => w.lvl === '0').from - run.meta.rampSec * 1000),
      };
      writeFileSync(join(dir, `samples-${world}.json`), JSON.stringify(sampler.samples));
      writeFileSync(join(dir, `k6-${world}.json`), JSON.stringify(k6, null, 2));
      writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));   // 每個世界跑完就存，中途失敗也留得下
    } finally {
      await restore();
    }
  }
} finally {
  tunnel.close();
  releaseSet();
  writeFileSync(join(dir, 'run.log'), logLines.join('\n'));
}

const basePath = o.baseline && (existsSync(join(o.baseline, 'run.json')) ? join(o.baseline, 'run.json') : o.baseline);
const baseline = basePath ? JSON.parse(readFileSync(basePath, 'utf8')) : null;
writeFileSync(join(dir, 'report.md'), render(run, baseline));
writeFileSync(join(dir, 'report.html'), renderHtml(run, baseline));
log(`完成：${join(dir, 'report.html')}`);
