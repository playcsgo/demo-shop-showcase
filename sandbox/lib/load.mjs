// 壓力測試（KIND=load）、耐久測試（KIND=soak）：只在本機手動跑，CI 不跑
//
// 壓力：每秒下單數一段一段往上加（例如 5 → 10 → 20），每一段各跑一次 k6，量這一段的延遲、錯誤率；
//       同時每 5 秒取樣 FPM 忙碌數、MySQL 連線數、SQS 堆積量；停止加壓後量「多久消化完」
// 耐久：固定的量跑很久，看各容器的記憶體有沒有一直長（洩漏）
// 時間不壓縮：要量的就是真實的時間
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { COMMAND_QUEUES, ROOT, sh } from './sets.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 背景取樣：FPM、MySQL 連線、SQS 堆積、各容器記憶體 */
function startSampler(set) {
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const at = Date.now();
      const [fpm, threads, backlog, mem] = await Promise.all([
        fetch(`http://localhost:${set.ports.core}/fpm-status?json`).then((r) => r.json()).catch(() => null),
        set.sql("SHOW STATUS LIKE 'Threads_connected'").then((r) => Number(r[0]?.[1] ?? 0)).catch(() => null),
        sqsBacklog(set),
        containerMemory(set),
      ]);
      samples.push({ at, fpmActive: fpm?.['active processes'] ?? null, fpmQueue: fpm?.['listen queue'] ?? null, fpmMaxChildrenReached: fpm?.['max children reached'] ?? null, dbConnections: threads, sqsBacklog: backlog, memoryMb: mem });
      await sleep(Math.max(0, 5000 - (Date.now() - at)));
    }
  })();
  return { samples, stop: async () => { running = false; await loop; } };
}

async function sqsBacklog(set) {
  let total = 0;
  for (const q of [...COMMAND_QUEUES, 'integration-events']) {
    const r = await set.compose(['exec', '-T', 'localstack', 'awslocal', 'sqs', 'get-queue-attributes', '--queue-url', `http://localhost:4566/000000000000/${q}`,
      '--attribute-names', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', '--output', 'json']);
    try { const a = JSON.parse(r.out).Attributes; total += Number(a.ApproximateNumberOfMessages) + Number(a.ApproximateNumberOfMessagesNotVisible); } catch { /* 取樣失敗就略過 */ }
  }
  return total;
}

async function containerMemory(set) {
  const r = await sh('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}']);
  const out = {};
  for (const line of r.out.split('\n')) {
    const [name, usage] = line.split('\t');
    if (!name?.startsWith(`${set.project}-`)) continue;
    const m = usage?.match(/^([\d.]+)\s*(KiB|MiB|GiB)/);
    if (m) out[name.slice(set.project.length + 1).replace(/-1$/, '')] = Math.round(Number(m[1]) * { KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]]);
  }
  return out;
}

const metric = (summary, name, key) => summary?.metrics?.[name]?.[key] ?? summary?.metrics?.[name]?.values?.[key] ?? null;

/** 依序跑每一段；回傳每一段的結果和取樣 */
export async function runLoadLevels(set, scenario, { seed, outDir, levels, hold, log }) {
  const sampler = startSampler(set);
  const stages = [];
  try {
    for (const rate of levels) {
      log(`每秒 ${rate} 筆訂單，維持 ${hold}`);
      const started = Date.now();
      const file = `k6-summary-${rate}.json`;
      const r = await sh('docker', [
        'run', '--rm', '--network', set.network, '-v', `${ROOT}:/repo:ro`, '-v', `${outDir}:/out`,
        '-e', 'BASE=http://core-nginx/api/v1', '-e', `SEED=${seed}`, '-e', `RATE=${rate}`, '-e', `DURATION=${hold}`,
        'grafana/k6:2.3.0', 'run', '--quiet', '--log-format=raw', `--summary-export=/out/${file}`,
        `/repo/${relative(ROOT, join(scenario.dir, 'traffic.js'))}`,
      ], { timeoutMs: 12 * 3600_000 });
      const s = existsSync(join(outDir, file)) ? JSON.parse(readFileSync(join(outDir, file), 'utf8')) : null;
      const inStage = sampler.samples.filter((x) => x.at >= started);
      stages.push({
        rate, hold, from: started, to: Date.now(),
        achievedPerSec: metric(s, 'iterations', 'rate'),
        p50: metric(s, 'http_req_duration', 'med'), p95: metric(s, 'http_req_duration', 'p(95)'), p99: metric(s, 'http_req_duration', 'p(99)'),
        checkoutP95: metric(s, 'http_req_duration{action:checkout}', 'p(95)'),
        errorRate: metric(s, 'http_req_failed', 'value') ?? metric(s, 'http_req_failed', 'rate'),
        unexpected: r.out.split('\n').filter((l) => l.startsWith('FAILED_REQUEST ')).length,
        droppedIterations: metric(s, 'dropped_iterations', 'count') ?? 0,   // k6 來不及送出的（客人進不來）
        maxFpmActive: Math.max(0, ...inStage.map((x) => x.fpmActive ?? 0)),
        maxFpmQueue: Math.max(0, ...inStage.map((x) => x.fpmQueue ?? 0)),
        maxDbConnections: Math.max(0, ...inStage.map((x) => x.dbConnections ?? 0)),
        maxSqsBacklog: Math.max(0, ...inStage.map((x) => x.sqsBacklog ?? 0)),
      });
    }
    // 停止加壓後，SQS 堆積多久消化完
    const stoppedAt = Date.now();
    log('停止加壓，量 SQS 消化時間');
    let drainSeconds = null;
    for (let i = 0; i < 360; i++) {
      if ((await sqsBacklog(set)) === 0) { drainSeconds = (Date.now() - stoppedAt) / 1000; break; }
      await sleep(2000);
    }
    return { stages, drainSeconds, samples: sampler.samples };
  } finally {
    await sampler.stop();
  }
}

/** 找上一次同一個情境的結果，拿來比較 */
export function previousLoad(scenarioName, currentDir) {
  const runs = join(ROOT, 'sandbox-runs');
  if (!existsSync(runs)) return null;
  for (const stamp of readdirSync(runs).sort().reverse()) {
    const f = join(runs, stamp, scenarioName, 'result.json');
    if (!existsSync(f) || join(runs, stamp, scenarioName) === currentDir) continue;
    const r = JSON.parse(readFileSync(f, 'utf8'));
    if (r.load) return { stamp, load: r.load, version: r.version };
  }
  return null;
}

/** 壓力／耐久的報告區塊 */
export function loadReport(r) {
  const L = r.load;
  if (!L) return [];
  const ms = (v) => (v == null ? '-' : `${Math.round(v)} ms`);
  const prev = r.previousLoad;
  const md = ['## 壓力測試結果', '', '| 每秒下單（目標→實際） | p50 | p95 | p99 | 結帳 p95 | 錯誤率 | 進不來 | FPM 忙碌（最多） | FPM 排隊 | DB 連線 | SQS 堆積 |' + (prev ? ' 上次 p95 | 變化 |' : ''),
    '|---|---|---|---|---|---|---|---|---|---|---|' + (prev ? '---|---|' : '')];
  for (const s of L.stages) {
    const before = prev?.load.stages.find((p) => p.rate === s.rate);
    const change = before?.p95 && s.p95 ? `${s.p95 > before.p95 ? '+' : ''}${(((s.p95 - before.p95) / before.p95) * 100).toFixed(0)}%` : '-';
    md.push(`| ${s.rate} → ${s.achievedPerSec?.toFixed(1) ?? '-'} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.checkoutP95)} | ${s.errorRate == null ? '-' : `${(s.errorRate * 100).toFixed(2)}%`} | ${s.droppedIterations} | ${s.maxFpmActive} | ${s.maxFpmQueue} | ${s.maxDbConnections} | ${s.maxSqsBacklog} |` + (prev ? ` ${ms(before?.p95)} | ${change} |` : ''));
  }
  md.push('', `停止加壓後 SQS 消化完：${L.drainSeconds == null ? '超過 12 分鐘還沒消化完' : `${L.drainSeconds.toFixed(0)} 秒`}`);
  if (prev) md.push('', `比較對象：${prev.stamp}（image ${prev.version}）`);
  // 耐久：記憶體從頭到尾的變化
  const first = L.samples.find((x) => Object.keys(x.memoryMb ?? {}).length);
  const last = [...L.samples].reverse().find((x) => Object.keys(x.memoryMb ?? {}).length);
  if (first && last && r.kind === 'soak') {
    md.push('', '## 記憶體（耐久測試：一直長就是洩漏）', '', '| 容器 | 開始 | 結束 | 變化 |', '|---|---|---|---|');
    for (const [k, v] of Object.entries(last.memoryMb)) {
      const a = first.memoryMb[k];
      md.push(`| ${k} | ${a ?? '-'} MB | ${v} MB | ${a ? `${v - a >= 0 ? '+' : ''}${v - a} MB` : '-'} |`);
    }
  }
  md.push('');
  return md;
}

export const writeSamples = (outDir, samples) => writeFileSync(join(outDir, 'samples.json'), JSON.stringify(samples));
