// 在某一套上跑一個情境：重置 → 設定世界 → 檢查時間 → k6 → 等收斂 → 判定 → 失敗才收集證據
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { partnerOverrides } from './scenario.mjs';
import { ROOT, sh } from './sets.mjs';
import { previousLoad, runLoadLevels, writeSamples } from './load.mjs';
import { collectEvidence, writeReport } from './report.mjs';

export const K6_IMAGE = 'grafana/k6:2.3.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真正做事的時間（不能壓縮）：完美世界、不壓縮時，hub 呼叫廠商＋處理內部 API 的 p99。時間檢查拿它和壓縮後的逾時比較
const BASELINE = join(ROOT, '.sandbox/baseline.json');
const readBaseline = () => (existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null);

async function measureBaseline(set, startNs) {
  const lines = await set.loki('{service="hub"} | json | ms != "" or responseTime != ""', { startNs });
  const values = lines.map((l) => { try { const j = JSON.parse(l.line); return Number(j.ms ?? j.responseTime); } catch { return NaN; } })
    .filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (values.length < 20) return null;
  const p99 = values[Math.floor(values.length * 0.99)];
  const b = { real_p99_ms: Math.max(1, Math.round(p99)), samples: values.length, measured_at: new Date().toISOString(), set: set.project };
  mkdirSync(join(ROOT, '.sandbox'), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(b, null, 2));
  return b;
}

export function newSeed() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * opts：seed（覆寫情境的 SEED）、only（重現某一輪）、outDir、exportAllLogs、log（進度輸出）
 * 回傳 result：{ scenario, set, seed, ok, status, checks[], timings{}, evidence }
 */
export async function runScenario(set, scenario, opts) {
  const log = (msg) => opts.log(`[${set.project}] ${scenario.name}：${msg}`);
  const timings = {};
  const t0 = Date.now();
  let recoverTimer = null;
  const lap = async (name, fn) => { const s = Date.now(); try { return await fn(); } finally { timings[name] = (Date.now() - s) / 1000; } };

  const seed = opts.seed ?? (!scenario.world.SEED || scenario.world.SEED === 'random' ? newSeed() : scenario.world.SEED);
  const isLoad = scenario.kind === 'load' || scenario.kind === 'soak';
  const timeScale = isLoad ? 1 : Number(opts.timeScale ?? scenario.world.TIME_SCALE ?? 1);   // 壓力、耐久要量真實的時間，不壓縮
  const outDir = opts.outDir;
  mkdirSync(outDir, { recursive: true });
  const ddServices = set.datadogServices();
  const result = { datadog: ddServices.length ? { services: ddServices, env: process.env.DD_ENV_NAME ?? `sandbox-${set.nn}`, site: process.env.DD_SITE ?? 'ap1.datadoghq.com' } : null, kind: scenario.kind, scenario: scenario.name, title: scenario.title, description: scenario.description, version: set.tag, world: scenario.world, set: set.project, setNo: set.n, seed, timeScale, only: opts.only ?? null, checks: [], timings, status: 'running' };

  try {
    // ① 準備：時間壓縮換了要重建 core；資料、佇列、廠商全部回到乾淨狀態
    if (set.timeScale !== timeScale) await lap('restart', () => { log(`時間壓縮 ×${timeScale}，重建 core`); return set.up(timeScale); });
    await lap('reset', () => { log('重置'); return set.reset(scenario.data, timeScale); });

    // ② 世界：partners 的一鍵設定＋個別覆寫＋這一輪的 seed、時間壓縮
    await lap('world', async () => {
      if (scenario.world.PRESET) await set.partners('POST', `/admin/presets/${scenario.world.PRESET}`);
      const overrides = partnerOverrides(scenario.world);
      if (Object.keys(overrides).length) await set.partners('PUT', '/admin/settings', overrides);
      await set.partners('PUT', '/admin/run', { seed, timeScale });
    });

    // ③ 時間壓縮之後，各項時間的大小關係還成立嗎？不成立就不跑（跑了也是假警報）
    const state = await set.partners('GET', '/admin/state');
    const holdTtl = Math.max(1, Math.round(state.settings.clinic.holdTtlSeconds / timeScale));
    const hub = await fetch(`http://localhost:${set.ports.hub}/health`).then((r) => r.json());
    const baseline = readBaseline();
    result.baseline = baseline;
    const tc = await set.artisanJson('sandbox:time-check', `--hold-ttl=${holdTtl}`, `--hub-timeouts-ms=${Object.values(hub.timeouts_ms ?? {}).join(',')}`,
      `--real-p99-ms=${baseline?.real_p99_ms ?? 100}`, '--json');
    result.timeCheck = tc.data;
    if (!tc.data.ok) {
      result.status = 'invalid';
      result.checks.push({ name: '時間設定合理', ok: false, detail: tc.data.rules.filter((r) => !r.ok).map((r) => `${r.rule}：${r.left} ${r.op} ${r.right} 不成立`).join('；') });
      return finish();
    }

    // ④ 流量：k6 跑在這一套的 Docker 網路裡，直接打 core-nginx
    const startNs = Date.now() * 1e6;
    result.startedAt = new Date().toISOString();
    // 廠商中斷一段時間後恢復（RECOVER_AFTER 秒後套用 RECOVER.* 的設定）：從流量開始時計時
    const recover = partnerOverrides(scenario.world, 'RECOVER.');
    // RECOVER_AFTER 也是「設定出來的時間」：跟著壓縮（不縮的話，×5 時短暫中斷會變成長時間中斷）
    if (scenario.world.RECOVER_AFTER && Object.keys(recover).length) {
      const after = Number(scenario.world.RECOVER_AFTER) / timeScale;
      recoverTimer = setTimeout(() => {
        set.partners('PUT', '/admin/settings', recover).then(() => log(`廠商恢復（${after.toFixed(0)} 秒，原本 ${scenario.world.RECOVER_AFTER} 秒）`)).catch(() => {});
      }, after * 1000);
    }
    if (isLoad) {
      // 壓力：一段一段加壓（RPS=5,10,20、HOLD=1m）；耐久：固定的量跑很久（RPS=5、DURATION=30m）
      const levels = String(opts.rps ?? scenario.world.RPS ?? '5').split(',').map(Number);
      const hold = scenario.kind === 'soak' ? (opts.duration ?? scenario.world.DURATION ?? '30m') : (opts.hold ?? scenario.world.HOLD ?? '1m');
      result.load = await lap('traffic', () => runLoadLevels(set, scenario, { seed, outDir, levels, hold, log }));
      writeSamples(outDir, result.load.samples);
      result.previousLoad = previousLoad(scenario.name, outDir);
      result.unexpected = [];
    }
    const k6 = isLoad ? { code: 0, out: '' } : await lap('traffic', () => { log(`k6（seed ${seed}${opts.only ? `，只跑 ${opts.only}` : ''}）`); return sh('docker', [
      'run', '--rm', '--network', set.network,
      '-v', `${ROOT}:/repo:ro`, '-v', `${outDir}:/out`,
      // SANDBOX_VIA_BFF=1：流量改走這一套的 BFF（shop.js 認得 BFF 的 cookie 登入），用來驗 BFF 本身，例如 Next.js 版（WEB-010）。預設照舊直打 core
      '-e', `BASE=${process.env.SANDBOX_VIA_BFF === '1' ? 'http://bff-gateway:3000/api' : 'http://core-nginx/api/v1'}`, '-e', `SEED=${seed}`, '-e', `ONLY=${opts.only ?? ''}`,
      K6_IMAGE, 'run', '--quiet', '--log-format=raw', '--summary-export=/out/k6-summary.json',
      `/repo/${relative(ROOT, join(scenario.dir, 'traffic.js'))}`,
    ], { timeoutMs: 6 * 3600_000 }); });
    if (!isLoad) writeFileSync(join(outDir, 'k6.log'), k6.out);
    const unexpected = isLoad ? [] : k6.out.split('\n').filter((l) => l.startsWith('FAILED_REQUEST ')).map((l) => JSON.parse(l.slice(15)));
    if (!isLoad) result.unexpected = unexpected;

    // ⑤ 等收斂：所有非同步流程（付款、出貨、預約、退款、outbox）都到終點
    // 收斂期限也跟著壓縮；但至少 30 秒：k6 和真正做事的時間縮不了
    const settleWithin = Math.max(30, Math.round(Number(scenario.expect.SETTLE_WITHIN ?? 180) / timeScale));
    let report;
    let settled = false;
    await lap('settle', async () => {
      log(`等待收斂（最多 ${settleWithin} 秒）`);
      const until = Date.now() + settleWithin * 1000;
      do {
        report = (await set.artisanJson('reconcile:check', '--json')).data;
        settled = Object.values(report.in_flight).every((v) => v === 0);
        if (settled) break;
        await sleep(3000);
      } while (Date.now() < until);
    });
    report = (await set.artisanJson('reconcile:check', '--json')).data;
    result.inFlight = report.in_flight;

    // ⑥ 判定
    await lap('check', async () => {
      const e = scenario.expect;
      const add = (name, ok, detail = '') => result.checks.push({ name, ok, detail });

      add(`${settleWithin} 秒內收斂`, settled, settled ? '' : `還在處理中：${JSON.stringify(report.in_flight)}`);
      if ((e.INVARIANTS ?? 'pass') === 'pass') {
        for (const [name, c] of Object.entries(report.checks)) if (!c.ok) add(`不變式：${name}`, false, `${c.count} 筆違反`);
        if (Object.values(report.checks).every((c) => c.ok)) add('不變式全部成立', true);
      }
      if ((e.K6 ?? 'pass') === 'pass') add('k6 門檻（thresholds）', k6.code === 0, k6.code === 0 ? '' : `k6 結束碼 ${k6.code}`);
      const maxUnexpected = Number(e.UNEXPECTED_MAX ?? 0);
      add(`非預期的 API 回應 ≤ ${maxUnexpected}`, unexpected.length <= maxUnexpected, unexpected.length ? `${unexpected.length} 筆` : '');

      const [[total, paid]] = await set.sql('SELECT COUNT(*), SUM(paid_at IS NOT NULL) FROM orders');
      result.orders = { total: Number(total), paid: Number(paid ?? 0) };
      const n = result.orders;
      if (e.ORDERS_EXACT !== undefined) add(`訂單數 = ${e.ORDERS_EXACT}`, n.total === Number(e.ORDERS_EXACT), `實際 ${n.total}`);
      if (e.ORDERS_MIN !== undefined) add(`訂單數 ≥ ${e.ORDERS_MIN}`, n.total >= Number(e.ORDERS_MIN), `實際 ${n.total}`);
      if (e.ORDERS_MAX !== undefined) add(`訂單數 ≤ ${e.ORDERS_MAX}`, n.total <= Number(e.ORDERS_MAX), `實際 ${n.total}`);
      if (e.PAID_MAX !== undefined) add(`已付款 ≤ ${e.PAID_MAX}`, n.paid <= Number(e.PAID_MAX), `實際 ${n.paid}`);
      if (e.MIN_PAID_RATIO !== undefined) {
        const ratio = n.total ? n.paid / n.total : 0;
        add(`已付款比例 ≥ ${e.MIN_PAID_RATIO}`, ratio >= Number(e.MIN_PAID_RATIO), `實際 ${n.paid}／${n.total}（${(ratio * 100).toFixed(1)}%）`);
      }
      if (e.MAX_ERROR_LOGS !== undefined) {
        const errors = await set.loki('{service=~".+", level="error"}', { startNs });
        add(`error log ≤ ${e.MAX_ERROR_LOGS}`, errors.length <= Number(e.MAX_ERROR_LOGS), `實際 ${errors.length} 筆`);
      }
    });

    result.status = result.checks.every((c) => c.ok) ? 'passed' : 'failed';

    // 完美世界、不壓縮、通過 → 更新「真正做事的時間」基準（沒有模擬延遲，量到的就是程式＋DB＋容器間傳輸）
    if (result.status === 'passed' && scenario.world.PRESET === 'perfect' && timeScale === 1 && !scenario.world['payment.mode'] && scenario.name === 'perfect') {
      const b = await measureBaseline(set, startNs).catch((err) => { result.logWarning = err.message; return null; });
      if (b) { result.baselineMeasured = b; log(`真實處理時間基準：p99 ${b.real_p99_ms} ms（${b.samples} 筆）`); }
    }

    // ⑦ 失敗才收集證據（只留跟失敗有關的）；[ci-debug] 時全部 log 都匯出
    if (result.status === 'failed' || opts.exportAllLogs) {
      await lap('evidence', () => collectEvidence(set, result, report, { startNs, outDir, exportAllLogs: opts.exportAllLogs }));
    }
  } catch (err) {
    result.status = 'error';
    result.error = String(err?.stack ?? err);
  }
  return finish();

  function finish() {
    clearTimeout(recoverTimer);
    timings.total = (Date.now() - t0) / 1000;
    result.repro = `scripts/sandbox.sh run ${scenario.name} --seed ${seed}`;
    writeReport(result, outDir);
    log(`${{ passed: '✅ 通過', failed: '❌ 失敗', invalid: '⚠️ 設定不合理', error: '💥 執行錯誤' }[result.status]}（${timings.total.toFixed(0)} 秒）`);
    return result;
  }
}
