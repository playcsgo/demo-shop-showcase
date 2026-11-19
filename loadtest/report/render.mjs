// 壓測報告：dev-container、K8s（自動擴充／預先開滿）共用同一份格式
// 輸入是一份 run.json（格式見 loadtest/report/README.md），比較對象（基準）也是一份 run.json
import { apiPool, runtimeLabel } from '../naming.mjs';
import { predictWorld } from './predict.mjs';

export const WORLDS = ['perfect', 'realistic'];
const WORLD_NAME = { perfect: '完美世界', realistic: '真實世界' };
const METRICS = ['query', 'pay_api', 'pay_e2e'];
const METRIC_NAME = { query: '查詢', pay_api: '結帳 API', pay_e2e: '結帳到付款完成' };
// 每一種請求（k6 的 step 標籤）；順序＝一輪購物的先後
export const STEP_NAME = { catalog: '查詢商品', login: '登入', cart: '看購物車', 'cart-clear': '清購物車', put: '放商品', 'put-booking': '預約時段（問醫院）', checkout: '結帳' };
const MODE_NAME = {
  'dev-container': 'dev-container（docker compose，每個服務 1 個容器）',
  'k8s-single': 'K8s 每個服務固定 1 個 Pod',
  'k8s-auto': 'K8s 自動擴充（HPA＋KEDA）',
  'k8s-max': 'K8s 開跑前直接開到上限',
  'k8s-fixed4': 'K8s 每個服務固定 4 個 Pod',
  'k8s-go-best': 'K8s Go 調校（core-api 4 個×20 條連線、relay 8 個，其他開到上限）',
};
// 舊的名字（之前的 run.json）
const ALIAS = { sandbox: 'dev-container', 'k8s-autoscale': 'k8s-auto', 'k8s-prepared': 'k8s-max' };
export const modeOf = (m) => ALIAS[m] ?? m;

// 「開始變慢」的判斷：任何一項成立就算
export const SLOW = { p95Times: 3, minSuccess: 0.99, minAchieved: 0.95 };
// 「飽和」的判斷：瓶頸只看 CPU 會漏掉等鎖、等廠商這種 CPU 很低的情況，所以同時看佇列、鎖、連線池
// SQS 不看積壓多少（量大積壓本來就多），看「維持那段積壓有沒有一直變多」＝進來的比消化的快
// 積壓的名字：SQS 的佇列，或 core 的 outbox（還沒被 relay 送出去的指令；取樣時跟佇列放在一起）
export const queueName = (q) => (q === 'outbox' ? 'outbox（core 還沒送出的指令）' : `SQS ${q}`);
export const SATURATED = { cpu: 0.8, fpm: 0.9, dbConns: 0.9, lockWaits: 10, sqsGrowthPerSec: 1, hostCpu: 0.9 };
// 「在等，不是在算」：忙滿或擴到上限，CPU 卻低於上限的這個比例；PHP-FPM 看每個忙碌的 worker 平均用幾顆核心
export const WAITING_CPU = 0.5;
export const WAITING_FPM_CORES = 0.3;

// ───────── 格式 ─────────
export const ms = (v) => (v == null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} 秒` : `${Math.round(v)} ms`);
const pct = (v, digits = 1) => (v == null ? '-' : `${(v * 100).toFixed(digits)}%`);
const dist = (d) => (d ? `${ms(d.p50)} ／ ${ms(d.p95)} ／ ${ms(d.p99)}` : '-');
const change = (before, after) => {
  if (before == null || after == null || before === 0) return '-';
  const c = (after - before) / before;
  return `${c > 0 ? '+' : ''}${(c * 100).toFixed(0)}%`;
};
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
export const levelName = (lv) => [lv.target.order ? `下單 ${lv.target.order}` : null, lv.target.query ? `查詢 ${lv.target.query}` : null].filter(Boolean).join('＋') + '／秒';

// ───────── 判斷 ─────────
/** 這一階為什麼算變慢（空陣列＝沒變慢） */
export function slowReasons(lv, idle) {
  const r = [];
  for (const m of ['query', 'pay_api']) {
    if (lv[m]?.p95 != null && idle?.[m]?.p95 && lv[m].p95 > idle[m].p95 * SLOW.p95Times) r.push(`${METRIC_NAME[m]} p95 是低流量的 ${(lv[m].p95 / idle[m].p95).toFixed(1)} 倍`);
  }
  for (const k of ['query', 'order']) {
    if (lv.success?.[k] != null && lv.success[k] < SLOW.minSuccess) r.push(`${k === 'query' ? '查詢' : '下單'}成功率 ${pct(lv.success[k], 2)}`);
    if (lv.target[k] && lv.achieved?.[k] != null && lv.achieved[k] < lv.target[k] * SLOW.minAchieved) r.push(`${k === 'query' ? '查詢' : '下單'}只送出 ${lv.achieved[k]}／${lv.target[k]}`);
  }
  if (lv.dropped > 0) r.push(`${lv.dropped} 個客人進不來`);
  return r;
}

/** 這一階有哪些東西飽和了：[{ key, label, text }]，key 在每一階都一樣（拿來畫時間線、找最早飽和的） */
export function saturation(sat, mode, runtime) {
  if (!sat) return [];
  const out = [];
  const add = (key, label, text) => out.push({ key, label, text });
  for (const [name, s] of Object.entries(sat.services ?? {})) {
    if (s.cpuCapM && s.cpuM / s.cpuCapM >= SATURATED.cpu) add(`cpu:${name}`, `${name} CPU`, `${name} CPU ${pct(s.cpuM / s.cpuCapM, 0)}（每個 Pod ${s.cpuM}m／上限 ${s.cpuCapM}m）`);
    if (s.memLimitMi && s.memMi / s.memLimitMi >= SATURATED.cpu) add(`mem:${name}`, `${name} 記憶體`, `${name} 記憶體 ${pct(s.memMi / s.memLimitMi, 0)}`);
    if (modeOf(mode) === 'k8s-auto' && s.maxPods && s.pods >= s.maxPods && s.maxPods > 1) add(`pods:${name}`, `${name} Pod 數`, `${name} 已擴到上限 ${s.pods} 個 Pod`);
  }
  if (sat.fpm?.max && sat.fpm.busy / sat.fpm.max >= SATURATED.fpm) add('fpm', apiPool(runtime).name, apiPool(runtime).full(sat.fpm.busy, sat.fpm.max, sat.fpm.queue));
  if (sat.db?.lockWaits >= SATURATED.lockWaits) add('lock', 'MySQL 等鎖', `MySQL ${sat.db.lockWaits} 個交易在等鎖`);
  if (sat.db?.maxConns && sat.db.conns / sat.db.maxConns >= SATURATED.dbConns) add('dbconn', 'MySQL 連線', `MySQL 連線 ${sat.db.conns}／${sat.db.maxConns}`);
  for (const [q, s] of Object.entries(sat.sqs ?? {})) {
    if (s.growthPerSec >= SATURATED.sqsGrowthPerSec) add(`sqs:${q}`, queueName(q), `${queueName(q)} 消化不及：積壓每秒多 ${s.growthPerSec} 則（最多 ${s.backlog} 則）`);
  }
  if (sat.host?.cpus && sat.host.cpuUsed / sat.host.cpus >= SATURATED.hostCpu) add('host', '整台電腦 CPU', `整台電腦 CPU ${sat.host.cpuUsed}／${sat.host.cpus} 顆`);
  return out;
}

/** 診斷提示：忙滿或擴到上限、CPU 卻很低 → 在等（鎖、資料庫、外部呼叫），多開 Pod 沒用 */
export function waitingHints(sat, mode, runtime) {
  if (!sat) return [];
  const out = [];
  const api = sat.services?.['core-api'];
  // 一個在算的 PHP worker 會用掉約 1 顆核心；全忙時平均每個 worker 用不到 0.3 顆，代表大部分時間在等
  // 整台電腦 CPU 已經滿的時候不算：那是在等 CPU 本身（核心不夠分），不是在等鎖或外部呼叫
  const hostFull = sat.host?.cpus && sat.host.cpuUsed / sat.host.cpus >= SATURATED.hostCpu;
  if (!hostFull && sat.fpm?.max && sat.fpm.busy / sat.fpm.max >= SATURATED.fpm && api?.pods) {
    const perWorker = (api.cpuM * api.pods) / 1000 / sat.fpm.busy;
    if (perWorker < WAITING_FPM_CORES) out.push(apiPool(runtime).waiting(sat.fpm.busy, perWorker.toFixed(2)));
  }
  for (const [name, s] of Object.entries(sat.services ?? {})) {
    if (modeOf(mode) === 'k8s-auto' && s.maxPods > 1 && s.pods >= s.maxPods && s.cpuCapM && s.cpuM / s.cpuCapM < WAITING_CPU) {
      out.push(`${name} 擴到上限 ${s.pods} 個，每個 Pod 的 CPU 卻只有 ${pct(s.cpuM / s.cpuCapM, 0)}：多開 Pod 沒用，它們在等`);
    }
  }
  return out;
}

/** 每個飽和指標從第幾階開始飽和（時間線） */
export function timeline(levels, mode, runtime) {
  const rows = new Map();
  levels.forEach((lv, i) => {
    for (const x of saturation(lv.sat, mode, runtime)) {
      if (!rows.has(x.key)) rows.set(x.key, { key: x.key, label: x.label, first: i, at: new Set() });
      rows.get(x.key).at.add(i);
    }
  });
  return [...rows.values()].sort((a, b) => a.first - b.first);
}

/** 一個世界的總結：撐得住的最高階、從哪一階開始變慢、當時誰飽和 */
export function summarize(world, mode, runtime) {
  const levels = world.levels ?? [];
  const firstSlow = levels.findIndex((lv) => slowReasons(lv, world.idle).length);
  const ok = firstSlow === -1 ? levels.at(-1) : levels[firstSlow - 1];
  const slow = firstSlow === -1 ? null : levels[firstSlow];
  const first = new Map(timeline(levels, mode, runtime).map((r) => [r.key, r.first]));
  return {
    maxOk: ok ? ok.target.order ?? null : null,
    maxOkQuery: ok ? ok.target.query ?? null : null,
    slowAt: slow,
    slowReasons: slow ? slowReasons(slow, world.idle) : [],
    hints: slow ? waitingHints(slow.sat, mode, runtime) : [],
    // 最早飽和的排前面：先看這幾個；只是提示，同一階一起飽和的要人判斷誰造成誰
    bottleneck: slow ? saturation(slow.sat, mode, runtime).map((x) => ({ ...x, first: first.get(x.key) })).sort((a, b) => a.first - b.first) : [],
  };
}

// ───────── 數量對帳、前台 vs 後台（2. 正確性底下） ─────────
const num = (v) => (v == null ? '-' : Math.round(v).toLocaleString('en-US'));
const reqCount = (lv) => Object.values(lv.steps ?? {}).reduce((s, x) => s + (x?.n ?? 0), 0);
const orderCount = (lv) => lv.steps?.checkout?.n ?? lv.pay_api?.n ?? null;

/** 理論＝設定的速率 × 時間（爬升段照線性算）；實際＝k6／資料庫實測。差多少應該 ≈ 進不來的客人 */
function countCheck(m, W) {
  const levels = W.levels;
  const hold = m.holdSec, ramp = m.rampSec;
  // 每筆下單幾個 request：用第一階（還沒變慢）的實測平均，不含查詢商品
  const base = levels[0];
  const perOrder = orderCount(base) ? (reqCount(base) - (base.steps?.catalog?.n ?? 0)) / orderCount(base) : null;
  const rows = levels.map((lv) => {
    const theoryOrders = lv.target.order * hold;
    const theoryReq = perOrder == null ? null : theoryOrders * perOrder + (lv.target.query ?? 0) * hold;
    return [levelName(lv), num(theoryOrders), num(orderCount(lv)), num(lv.dropped ?? 0), num(theoryReq), num(reqCount(lv))];
  });
  const sum = (f) => levels.reduce((s, lv) => s + (f(lv) ?? 0), 0);
  rows.push(['**合計（維持段）**', num(sum((lv) => lv.target.order * hold)), num(sum(orderCount)), num(sum((lv) => lv.dropped)),
    num(perOrder == null ? null : sum((lv) => lv.target.order * hold * perOrder + (lv.target.query ?? 0) * hold)), num(sum(reqCount))]);
  const out = table(['階段', '理論下單', '實際下單', '進不來', '理論 request', '實際 request'], rows);

  // 整次（含低流量、爬升段）：每一階從前一階的速率線性爬到目標，第一階從 0 開始
  const idleOrders = (m.idle?.order ?? 0) * (m.idle?.holdSec ?? 0);
  const theoryAll = idleOrders + levels.reduce((s, lv, i) => s + ramp * ((i ? levels[i - 1].target.order : 0) + lv.target.order) / 2 + hold * lv.target.order, 0);
  const droppedAll = sum((lv) => lv.dropped) + (W.idle?.dropped ?? 0);
  const actual = W.logCoverage?.dbOrders ?? null;
  const expect = theoryAll - droppedAll;
  out.push('', `整次（含爬升段${idleOrders ? '、低流量' : ''}）：理論訂單 ${num(theoryAll)} − 進不來 ${num(droppedAll)} ＝ ${num(expect)}；實際（資料庫）${num(actual)}` +
    (actual == null ? '' : `，差 ${num(actual - expect)} 筆${Math.abs(actual - expect) <= Math.max(10, expect * 0.01) ? ' ✅' : ' ⚠️ 差太多，要查'}`));
  out.push('', `理論 request＝理論下單 × 每筆下單 ${perOrder == null ? '-' : perOrder.toFixed(2)} 個 request（第一階實測平均）＋ 查詢；只統計維持段。`);
  return out;
}

/** 結帳 API（前台）快不快 vs 付款完成（後台）有沒有積壓：🔴＝第一階的 3 倍以上，或超過「5. 瓶頸」的飽和門檻 */
function frontBack(m, W) {
  const levels = W.levels;
  const base = levels[0];
  const slow = (v, b) => (v != null && b ? (v > b * SLOW.p95Times ? '🔴 ' : '🟢 ') : '');
  const flag = (hit) => (hit ? '🔴 ' : '');
  const worstQueue = (lv) => Object.entries(lv.sat?.sqs ?? {}).sort((a, b) => b[1].growthPerSec - a[1].growthPerSec || b[1].backlog - a[1].backlog)[0];
  return table(['指標', ...levels.map(levelName)], [
    ['結帳 API p95（前台）', ...levels.map((lv) => slow(lv.pay_api?.p95, base.pay_api?.p95) + ms(lv.pay_api?.p95))],
    ['結帳到付款完成 p50（後台）', ...levels.map((lv) => slow(lv.pay_e2e?.p50, base.pay_e2e?.p50) + ms(lv.pay_e2e?.p50))],
    ['積壓最多的佇列（每秒增加）', ...levels.map((lv) => {
      const q = worstQueue(lv);
      return q ? `${flag(q[1].growthPerSec >= SATURATED.sqsGrowthPerSec)}${q[0]} ${q[1].backlog}（${q[1].growthPerSec > 0 ? '+' : ''}${q[1].growthPerSec}）` : '-';
    })],
    ['整台電腦 CPU', ...levels.map((lv) => (lv.sat?.host ? `${flag(lv.sat.host.cpuUsed / lv.sat.host.cpus >= SATURATED.hostCpu)}${lv.sat.host.cpuUsed}／${lv.sat.host.cpus} 顆` : '-'))],
    ['MySQL 等鎖的交易', ...levels.map((lv) => (lv.sat?.db ? `${flag(lv.sat.db.lockWaits >= SATURATED.lockWaits)}${lv.sat.db.lockWaits}` : '-'))],
    [apiPool(m.runtime).row, ...levels.map((lv) => (m.runtime === 'octane' ? '（Octane）' : lv.sat?.fpm ? `${flag(lv.sat.fpm.busy / lv.sat.fpm.max >= SATURATED.fpm)}${lv.sat.fpm.busy}／${lv.sat.fpm.max}` : '-'))],
  ]);
}

/** 不變式全過才算數 */
export const invariantsPass = (run) => WORLDS.every((w) => !run.worlds[w] || (run.worlds[w].correctness?.invariants ?? []).every((i) => i.pass));

// ───────── 報告 ─────────
export function render(run, baseline = null) {
  const m = run.meta;
  const worlds = WORLDS.filter((w) => run.worlds[w]);
  const valid = invariantsPass(run);
  const md = [];

  md.push(`# 壓測報告 ${m.id}`, '');
  if (run.sample) md.push('> ⚠️ **範例資料**：數字是假的，只用來確認報告格式', '');
  if (!valid) md.push('> ❌ **不變式沒通過：帳不對，這一輪的效能數字不算數**（見「2. 正確性」）', '');
  md.push(`這一輪改了什麼：**${m.change ?? '（基準，沒有改動）'}**${baseline ? `　比較對象：\`${baseline.meta.id}\`` : ''}`, '');

  // 0. 測試條件
  md.push('## 0. 測試條件', '');
  md.push(...table(['項目', '設定'], [
    ['版本', `\`${m.commit}\``],
    ['模式', MODE_NAME[modeOf(m.mode)] ?? m.mode],
    ['core-api 執行方式', m.runtime ? runtimeLabel(m.runtime) : '-（舊的報告沒有記錄；當時都是 PHP-FPM）'],
    ['世界', worlds.map((w) => WORLD_NAME[w]).join('＋')],
    ['物流狀態回呼', m.logisticsCallbacks === false ? '關（只到交給物流，不回傳狀態）' : '開'],
    ['開始時間', m.startedAt],
    ['seed', String(m.seed)],
    ['商品', m.catalog],
    ['庫存分桶', String(m.buckets)],
    ['資料庫', m.dbReset ? '每個世界開跑前重建' : '⚠️ 沒有重建'],
    ['低流量基準', m.idle ? `每秒下單 ${m.idle.order}、查詢 ${m.idle.query}，維持 ${m.idle.holdSec} 秒` : '-'],
    ['各階負載', `下單 ${m.levels.order?.join(' → ') || '（不打）'}／秒；查詢 ${m.levels.query?.join(' → ') || '（不打）'}／秒${m.queryRatio ? `（查詢＝下單 × ${m.queryRatio}）` : ''}。兩條流量**同時**打，不是先後`],
    ['每一階', `爬升 ${m.rampSec} 秒、維持 ${m.holdSec} 秒，只統計維持那段`],
    ['環境', m.env ? Object.entries(m.env).map(([k, v]) => `${k} ${v}`).join('、') : '-'],
  ]), '');
  md.push('廠商設定（這一輪實際套用的值，推測值也從這裡算）：', '');
  md.push(...table(['世界', '金流', '物流', '醫院'], worlds.map((w) => {
    const s = run.worlds[w].partnerSettings ?? {};
    const f = (p) => (p ? `${p.latencyMs ?? 0}${p.latencyJitterMs ? `＋${p.latencyJitterMs}×u³` : ''} ms${p.errorRate ? `、錯誤 ${pct(p.errorRate)}` : ''}${p.callbackDelayMs != null ? `、callback ${p.callbackDelayMs} ms` : ''}` : '-');
    return [WORLD_NAME[w], f(s.payment), f(s.logistics), f(s.clinic)];
  })), '');

  // 1. 結論
  md.push('## 1. 結論', '');
  for (const w of worlds) {
    const s = summarize(run.worlds[w], m.mode, m.runtime);
    const line = s.slowAt
      ? `撐得住 **下單 ${s.maxOk ?? '（第一階就不行）'}／秒**，${levelName(s.slowAt)} 開始變慢。最早飽和的：${s.bottleneck.length ? s.bottleneck.slice(0, 2).map((x) => x.text).join('；') : '⚠️ 沒有任何指標飽和，缺監控資料，要補'}${s.bottleneck.length > 2 ? `（另外 ${s.bottleneck.length - 2} 項見第 5 節）` : ''}`
      : `每一階都撐得住（最高 **下單 ${s.maxOk}／秒**${s.maxOkQuery ? `、查詢 ${s.maxOkQuery}／秒` : ''}），還沒碰到上限`;
    md.push(`- **${WORLD_NAME[w]}**：${line}`);
  }
  if (baseline) {
    for (const w of worlds.filter((x) => baseline.worlds[x])) {
      const a = summarize(baseline.worlds[w], baseline.meta.mode, baseline.meta.runtime);
      const b = summarize(run.worlds[w], m.mode, m.runtime);
      md.push(`- **跟基準比（${WORLD_NAME[w]}）**：撐得住的下單 ${a.maxOk ?? '-'} → ${b.maxOk ?? '-'}／秒`);
    }
  }
  md.push('');

  // 2. 正確性
  md.push('## 2. 正確性', '');
  for (const w of worlds) {
    const inv = run.worlds[w].correctness?.invariants ?? [];
    const failed = inv.filter((i) => !i.pass);
    const W = run.worlds[w];
    const cov = W.logCoverage;
    const extra = [
      W.drainSeconds !== undefined ? (W.drainSeconds == null ? '⚠️ 停止加壓後 15 分鐘還沒消化完' : `停止加壓後 ${W.drainSeconds} 秒消化完`) : null,
      cov ? `Loki 收到 ${cov.lokiPlaced}／${cov.dbOrders} 筆下單 log${cov.dbOrders && cov.lokiPlaced / cov.dbOrders < 0.99 ? '（⚠️ log 有掉，pay_e2e 樣本不完整）' : ''}` : null,
      W.samplerErrors ? `⚠️ 取樣失敗 ${W.samplerErrors} 次` : null,
    ].filter(Boolean);
    md.push(`**${WORLD_NAME[w]}**：不變式 ${failed.length ? `❌ ${failed.length}／${inv.length} 項沒過` : `✅ ${inv.length} 項全過`}${extra.length ? `；${extra.join('；')}` : ''}`, '');
    if (failed.length) md.push(...table(['不變式', '結果'], failed.map((i) => [i.name, i.detail ?? ''])), '');
  }
  md.push('請求成功率（每一階）：', '');
  md.push(...table(['階段', ...worlds.flatMap((w) => [`${WORLD_NAME[w]} 查詢`, `${WORLD_NAME[w]} 下單`])],
    (run.worlds[worlds[0]].levels ?? []).map((lv, i) => [levelName(lv), ...worlds.flatMap((w) => {
      const x = run.worlds[w].levels?.[i]?.success ?? {};
      return [pct(x.query, 2), pct(x.order, 2)];
    })])), '');
  for (const w of worlds) {
    const W = run.worlds[w];
    if (!W.levels?.length) continue;
    md.push(`**${WORLD_NAME[w]}：數量對帳（理論 vs 實際）**`, '', ...countCheck(m, W), '');
    md.push(`**${WORLD_NAME[w]}：前台 vs 後台（每一階）**`, '', ...frontBack(m, W), '');
  }

  // 3. 推測 vs 實測
  md.push('## 3. 推測 vs 實測（低流量基準）', '');
  md.push('p50 ／ p95 ／ p99。偏差＝實測 p95 ÷ 推測 p95，超過 1.5 倍或低於 0.5 倍標 ⚠️', '');
  const rows = [];
  for (const w of worlds) {
    const pred = predictWorld(run.worlds[w].partnerSettings);
    for (const k of METRICS) {
      const real = run.worlds[w].idle?.[k];
      const ratio = real?.p95 && pred[k].p95 ? real.p95 / pred[k].p95 : null;
      const flag = ratio == null ? '-' : `${ratio.toFixed(2)}×${ratio > 1.5 || ratio < 0.5 ? ' ⚠️' : ''}`;
      rows.push([`\`${w}_${k}\``, dist(pred[k]), dist(real), real?.n ?? '-', flag, pred[k].basis]);
    }
  }
  md.push(...table(['指標', '推測', '實測', '樣本數', '偏差', '推測算法'], rows), '');

  // 4. 各階負載
  md.push('## 4. 各階負載', '');
  for (const w of worlds) {
    md.push(`### ${WORLD_NAME[w]}`, '');
    md.push(...table(['階段', '實際／秒', '進不來', `${METRIC_NAME.query} p50／p95／p99`, `${METRIC_NAME.pay_api} p50／p95／p99`, `${METRIC_NAME.pay_e2e} p50／p95／p99`, '沒等到付款完成', '變慢？'],
      (run.worlds[w].levels ?? []).map((lv) => {
        const why = slowReasons(lv, run.worlds[w].idle);
        return [levelName(lv), [lv.achieved?.query, lv.achieved?.order].filter((x) => x != null).join('＋'), String(lv.dropped ?? 0),
          dist(lv.query), dist(lv.pay_api), dist(lv.pay_e2e), `${lv.e2eUnfinished ?? 0}${lv.e2eFailed ? `（另有 ${lv.e2eFailed} 筆付款失敗）` : ''}`, why.length ? `🔴 ${why.join('、')}` : '🟢'];
      })), '');
    const W = run.worlds[w];
    const cols = [['低流量', W.idle], ...(W.levels ?? []).map((lv) => [levelName(lv).replace(/＋查詢.*/, '／秒').replace('／秒／秒', '／秒'), lv])];
    const steps = Object.keys(STEP_NAME).filter((st) => cols.some(([, x]) => x?.steps?.[st]));
    if (steps.length) {
      md.push('每一種請求（p50 ／ p95 ／ p99；結帳含預約）：', '');
      md.push(...table(['請求', ...cols.map(([n]) => n)], steps.map((st) => [STEP_NAME[st], ...cols.map(([, x]) => (x?.steps?.[st] ? `${dist(x.steps[st])}（${x.steps[st].n}）` : '-'))])), '');
    }
  }

  // 5. 瓶頸
  md.push('## 5. 瓶頸', '');
  md.push(`飽和的判斷：CPU（單執行緒的服務上限 1 核）／記憶體 ≥ ${pct(SATURATED.cpu, 0)} 上限、${apiPool(m.runtime).name} ≥ ${pct(SATURATED.fpm, 0)} 用滿、等鎖 ≥ ${SATURATED.lockWaits} 個交易、DB 連線 ≥ ${pct(SATURATED.dbConns, 0)}、SQS／outbox 積壓每秒增加 ≥ ${SATURATED.sqsGrowthPerSec} 則、整台電腦 CPU ≥ ${pct(SATURATED.hostCpu, 0)}${modeOf(m.mode) === 'k8s-auto' ? '、Pod 擴到上限' : ''}。每一階取維持那段的最大值`, '');
  for (const w of worlds) {
    md.push(`### ${WORLD_NAME[w]}`, '');
    const lvs = run.worlds[w].levels ?? [];
    const names = [...new Set(lvs.flatMap((lv) => Object.keys(lv.sat?.services ?? {})))];
    // 每個服務：Pod 數（K8s）／CPU（每個 Pod）
    md.push(...table(['服務', ...lvs.map(levelName)], names.map((n) => [n, ...lvs.map((lv) => {
      const s = lv.sat?.services?.[n];
      if (!s) return '-';
      const cpu = s.cpuCapM ? `${s.cpuM}m（${pct(s.cpuM / s.cpuCapM, 0)}）` : `${s.cpuM}m`;
      return modeOf(m.mode) === 'dev-container' ? `${cpu}　${s.memMi} Mi` : `${s.pods}${s.maxPods ? `／${s.maxPods}` : ''} 個　${cpu}　${s.memMi} Mi`;
    })])), '');
    md.push(`上表：${modeOf(m.mode) === 'dev-container' ? 'CPU（佔上限）　記憶體' : 'Pod 數／上限　每個 Pod 的平均 CPU（佔上限）　每個 Pod 的平均記憶體'}。沒設 CPU limit：單執行緒的服務上限算 1 核；${apiPool(m.runtime).process}、MySQL 沒有單一上限，不算百分比（看 ${apiPool(m.runtime).name}和整台電腦）`, '');
    md.push(...table(['飽和指標', ...lvs.map(levelName)], [
      [apiPool(run.meta.runtime).rowQueue, ...lvs.map((lv) => (run.meta.runtime === 'octane' ? '（Octane，沒有 FPM）' : lv.sat?.fpm ? `${lv.sat.fpm.busy}／${lv.sat.fpm.max}${lv.sat.fpm.queue ? `（${lv.sat.fpm.queue}）` : ''}` : '-'))],
      ['MySQL 連線／上限', ...lvs.map((lv) => (lv.sat?.db ? `${lv.sat.db.conns}／${lv.sat.db.maxConns}` : '-'))],
      ['MySQL 等鎖的交易', ...lvs.map((lv) => String(lv.sat?.db?.lockWaits ?? '-'))],
      ...[...new Set(lvs.flatMap((lv) => Object.keys(lv.sat?.sqs ?? {})))].map((q) => [`${queueName(q)} 積壓（每秒增加）`, ...lvs.map((lv) => {
        const s = lv.sat?.sqs?.[q];
        return s ? `${s.backlog}（${s.growthPerSec > 0 ? '+' : ''}${s.growthPerSec}）` : '-';
      })]),
      ['整台電腦 CPU', ...lvs.map((lv) => (lv.sat?.host ? `${lv.sat.host.cpuUsed}／${lv.sat.host.cpus} 顆` : '-'))],
    ]), '');
    const tl = timeline(lvs, m.mode, m.runtime);
    md.push('飽和時間線（🔴＝這一階飽和；照最早飽和排序。只是提示：同一階一起飽和的，要人判斷誰造成誰）：', '');
    md.push(...(tl.length ? table(['指標', ...lvs.map(levelName)], tl.map((r) => [r.label, ...lvs.map((_, i) => (r.at.has(i) ? '🔴' : '·'))])) : ['（每一階都沒有指標飽和）']), '');
    const s = summarize(run.worlds[w], m.mode, m.runtime);
    if (!s.slowAt) md.push('**判斷**：每一階都沒變慢', '');
    else if (!s.bottleneck.length) md.push(`**判斷**：${levelName(s.slowAt)} 開始變慢，但⚠️ 沒有任何指標飽和：原因不在收集的指標裡，要補監控`, '');
    else {
      const root = s.bottleneck.filter((x) => x.first === s.bottleneck[0].first);
      const later = s.bottleneck.filter((x) => x.first !== s.bottleneck[0].first);
      md.push(`**判斷**：${levelName(s.slowAt)} 開始變慢（${s.slowReasons.join('、')}）`, '');
      md.push(`- 最早飽和（${levelName(lvs[root[0].first])} 起）：${root.map((x) => x.text).join('；')}`);
      if (later.length) md.push(`- 之後才飽和（可能是連帶效應）：${later.map((x) => x.text).join('；')}`);
      for (const h of s.hints) md.push(`- 💡 ${h}`);
      md.push('');
    }
  }

  // 6. 跟基準比
  if (baseline) {
    md.push('## 6. 跟基準比較', '');
    md.push(`基準：\`${baseline.meta.id}\`（${baseline.meta.change ?? '基準'}，版本 \`${baseline.meta.commit}\`）`, '');
    const diffs = diffConditions(baseline.meta, m);
    const shared = worlds.filter((x) => baseline.worlds[x]);
    if (!shared.length) diffs.push(`世界不同：${Object.keys(baseline.worlds).map((w) => WORLD_NAME[w]).join('＋')} → ${worlds.map((w) => WORLD_NAME[w]).join('＋')}（沒有可以逐項比的世界）`);
    md.push(diffs.length ? `兩輪條件的差異：${diffs.join('；')}` : '⚠️ 兩輪的測試條件完全一樣：比較不出差異', '');
    if (diffs.length > 1) md.push('', '⚠️ **不只差一個條件**：變化不能全算在「這一輪改了什麼」上', '');
    for (const w of worlds.filter((x) => baseline.worlds[x])) {
      md.push(`### ${WORLD_NAME[w]}`, '');
      const rowsCmp = [['低流量', baseline.worlds[w].idle, run.worlds[w].idle]];
      for (const lv of run.worlds[w].levels ?? []) {
        const before = baseline.worlds[w].levels?.find((x) => x.target.order === lv.target.order && x.target.query === lv.target.query);
        rowsCmp.push([levelName(lv), before, lv]);
      }
      md.push(...table(['階段', ...METRICS.flatMap((k) => [`${METRIC_NAME[k]} p95`, `${METRIC_NAME[k]} p99`])],
        rowsCmp.map(([name, a, b]) => [name, ...METRICS.flatMap((k) => ['p95', 'p99'].map((p) => (a?.[k] || b?.[k] ? `${ms(a?.[k]?.[p])} → ${ms(b?.[k]?.[p])}（${change(a?.[k]?.[p], b?.[k]?.[p])}）` : '-')))])), '');
    }
  }

  // 附錄
  md.push('## 附錄：指標定義', '');
  md.push(...table(['指標', '從', '到', '怎麼量'], [
    ['`query`', 'k6 送出 `GET /catalog`', '收到回應', 'k6 每筆請求的時間'],
    ['`pay_api`', 'k6 送出 `POST /checkout`', '收到回應', 'k6 每筆請求的時間，只算直送／寄倉'],
    ['`pay_e2e`', 'core 寫下訂單（log `order placed`）', '付款完成（log `payment succeeded → order PAID`）', 'Loki 用 correlation_id 配對兩行 log 的時間戳，只算直送／寄倉；統計結束時還沒付款完成的列在「沒等到付款完成」'],
  ]), '');
  return md.join('\n');
}

/** 兩輪的測試條件差在哪（id、時間、版本以外） */
export function diffConditions(a, b) {
  // 舊的報告沒有這些欄位：當時的預設值（PHP-FPM、物流回呼開）
  const norm = (m) => ({ ...m, runtime: m.runtime ?? 'fpm', logisticsCallbacks: m.logisticsCallbacks ?? true });
  [a, b] = [norm(a), norm(b)];
  const keys = ['mode', 'runtime', 'catalog', 'buckets', 'logisticsCallbacks', 'queryRatio', 'dbReset', 'seed', 'rampSec', 'holdSec'];
  const out = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k}：${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
  if (JSON.stringify(a.levels) !== JSON.stringify(b.levels)) out.push('各階負載不同');
  if (JSON.stringify(a.idle) !== JSON.stringify(b.idle)) out.push('低流量基準的設定不同');
  return out;
}
