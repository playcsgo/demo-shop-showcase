#!/usr/bin/env node
// sandbox CLI（UI 和 CI 都呼叫這一支）
//
//   node sandbox/cli.mjs run [情境…] [選項]     沒指定情境 → 跑全部 KIND=test 的情境
//     --parallel N        同時用幾套（第 1～N 套）；情境排成一列，哪一套先跑完就拿下一個
//     --sets 1,3          指定用哪幾套
//     --seed 42           覆寫情境的 seed（重現用）
//     --only s42-u17-i3   只跑某一輪（重現用；要搭配同一個 seed）
//     --repeat N          每個情境用不同的 seed 各跑 N 次（找偶爾才出現的問題）
//     --kind test,load    要跑哪幾種情境（預設 test；load、soak 只在本機手動跑）
//     --time-scale 5      時間壓縮倍數（覆寫情境的 TIME_SCALE；壓力、耐久一律不壓縮）
//     --datadog all       這次用到的套數送 Datadog：all、off 或 core-api,hub（不指定＝沿用每套存下來的選擇，預設全關）
//     --export-all-logs   不管過不過，全部 log 都匯出（CI 的 [ci-debug]）
//     --no-build          不重新 build image
//     --down              跑完把用到的套數刪掉（CI 用）
//   壓力／耐久（KIND=load／soak，只在本機手動跑；要獨佔機器）
//     --rps 5,10,20       每秒下單數，一段一段加壓（耐久只用第一個）
//     --hold 1m           壓力測試每一段維持多久
//     --duration 30m      耐久測試跑多久
//     --force             其他套數還在跑也照樣執行（數字會不準）
//   node sandbox/cli.mjs list
//   node sandbox/cli.mjs logs <GitHub run id｜sandbox-runs/資料夾>   用本機 Grafana（port 28000）查 CI 的 log
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { newSeed, runScenario } from './lib/runner.mjs';
import { allScenarios, loadScenario } from './lib/scenario.mjs';
import { ROOT, SandboxSet, sh } from './lib/sets.mjs';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    parallel: { type: 'string' }, sets: { type: 'string' }, seed: { type: 'string' }, only: { type: 'string' },
    repeat: { type: 'string' }, kind: { type: 'string' }, 'export-all-logs': { type: 'boolean' },
    'no-build': { type: 'boolean' }, down: { type: 'boolean' }, force: { type: 'boolean' },
    rps: { type: 'string' }, hold: { type: 'string' }, duration: { type: 'string' }, 'time-scale': { type: 'string' }, datadog: { type: 'string' },
  },
});
const [command, ...names] = positionals;
const log = (msg) => console.log(`${new Date().toTimeString().slice(0, 8)} ${msg}`);

if (command === 'list') {
  for (const s of allScenarios(['test', 'load', 'soak'])) console.log(`${s.name.padEnd(22)} ${s.kind.padEnd(5)} ${s.title}：${s.description}`);
  process.exit(0);
}
if (command === 'logs') {
  const { openLogs } = await import('./lib/viewer.mjs');
  try { await openLogs(names[0] ?? '', log); process.exit(0); } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
if (command !== 'run') {
  console.error('用法：node sandbox/cli.mjs run [情境…] [--parallel N] [--seed S] [--only FLOW] [--repeat N] [--down]');
  process.exit(2);
}

const kinds = (opt.kind ?? 'test').split(',');
const scenarios = names.length ? names.map(loadScenario) : allScenarios(kinds);
const repeat = Number(opt.repeat ?? 1);
// 工作佇列：同一個情境 repeat 次時，第 2 次以後換新的 seed
const queue = scenarios.flatMap((s) => Array.from({ length: repeat }, (_, i) => ({ scenario: s, seed: i === 0 ? opt.seed : newSeed(), round: i + 1 })));
const setNos = opt.sets ? opt.sets.split(',').map(Number) : Array.from({ length: Number(opt.parallel ?? 1) }, (_, i) => i + 1);

const started = Date.now();
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const runDir = join(ROOT, 'sandbox-runs', stamp);
mkdirSync(runDir, { recursive: true });

// --no-build 但這個版本的 image 還不存在（例如剛 commit 完，tag 換了）→ 還是要 build，不然 compose 會去 Docker Hub 找而失敗
const wantTag = (await sh('scripts/sandbox.sh', ['tag'])).out.trim();
const haveImage = (await sh('docker', ['image', 'inspect', `demo-sandbox/core-api:${wantTag}`])).code === 0;
if (opt['no-build'] && !haveImage) log(`image ${wantTag} 還不存在，忽略 --no-build`);
if (!opt['no-build'] || !haveImage) {
  log('build image（沒改到的部分直接沿用）');
  const b = await sh('scripts/sandbox.sh', ['build']);
  if (b.code !== 0) { console.error(b.out); process.exit(1); }
}
const tag = (await sh('scripts/sandbox.sh', ['tag'])).out.trim();
const sets = setNos.map((n) => new SandboxSet(n, tag, opt.datadog ?? null));

// 壓力／耐久要獨佔機器：其他套數同時在跑，會搶 CPU，量出來的數字沒有意義
if (scenarios.some((s) => s.kind !== 'test')) {
  if (sets.length > 1) { console.error('壓力／耐久測試一次只能用一套（不要加 --parallel）'); process.exit(2); }
  const others = (await sh('docker', ['ps', '--format', '{{.Label "com.docker.compose.project"}}'])).out.split('\n')
    .filter((p) => /^demo-sb\d{2}$/.test(p) && p !== sets[0].project);
  if (others.length && !opt.force) {
    console.error(`其他測試的套數還在跑（${[...new Set(others)].join('、')}），數字會不準。先 scripts/sandbox.sh down N，或加 --force。`);
    process.exit(2);
  }
  if ((await sh('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=demo-claude'])).out.trim()) log('注意：日常開發那套也在跑，會分掉一些 CPU');
}

log(`${queue.length} 個情境 × ${sets.length} 套（image ${tag}）→ ${runDir}`);
for (const s of sets) await s.lock(`跑情境（pid ${process.pid}）`, log);
process.on('SIGINT', () => process.exit(130));   // Ctrl+C 也要釋放鎖（exit 時清掉）
process.on('SIGTERM', () => process.exit(143));
await Promise.all(sets.map(async (s) => { log(`啟動 ${s.project}`); await s.up(1); }));

// log 管線自我檢查：一分鐘內 Loki 還沒收到任何服務 → 印出 Alloy 的計數，看得出斷在哪一段
//   讀到 0：Alloy 沒找到／讀不到容器　讀到 > 0、送出 0：送不進 Loki　送出 > 0、Loki 沒有：查詢那一段
// 這一行在「跑情境」步驟裡，後面的步驟被取消也看得到
await Promise.all(sets.map(async (s) => {
  let p;
  for (let i = 0; i < 12; i++) {
    p = await s.logPipeline();
    if (p.services.length) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const alloy = `Alloy 讀到 ${p.alloy.read}、送出 ${p.alloy.sent}、丟掉 ${p.alloy.dropped} 行`;
  if (p.services.length) log(`${s.project} 的 log：Loki 收到 ${p.services.join('、')}｜${alloy}`);
  else console.log(`${process.env.GITHUB_ACTIONS ? '::warning::' : ''}${s.project} 的 Loki 沒有任何 log${p.lokiError ? `（查詢失敗：${p.lokiError}）` : ''}｜${alloy}`);
}));

// 要壓縮時間、卻還沒量過「真正做事的時間」基準（例如 CI 的新機器）→ 先用 ×1 跑一次完美世界量出來
// 基準存在 .sandbox/baseline.json；沒有它，時間檢查只能用預設的 100 ms，在比較慢的機器上可能不準
if (queue.some((j) => Number(opt['time-scale'] ?? j.scenario.world.TIME_SCALE ?? 1) > 1) && !existsSync(join(ROOT, '.sandbox/baseline.json'))) {
  log('還沒有真實處理時間的基準：先用 ×1 跑一次完美世界');
  const r = await runScenario(sets[0], loadScenario('perfect'), { outDir: join(runDir, 'baseline-perfect'), log, timeScale: 1 });
  if (r.status !== 'passed') { console.error(`量基準的完美世界沒有通過，先看 ${join(runDir, 'baseline-perfect', 'report.md')}`); process.exit(1); }
}

const results = [];
await Promise.all(sets.map(async (set) => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const dir = join(runDir, job.round > 1 ? `${job.scenario.name}-r${job.round}` : job.scenario.name);
    const r = await runScenario(set, job.scenario, { seed: job.seed, only: opt.only, outDir: dir, exportAllLogs: opt['export-all-logs'], log, rps: opt.rps, hold: opt.hold, duration: opt.duration, timeScale: opt['time-scale'] });
    r.dir = basename(dir);
    results.push(r);
  }
}));

if (opt.down) await Promise.all(sets.map((s) => s.down()));

// 總結
const total = (Date.now() - started) / 1000;
const icon = { passed: '✅', failed: '❌', invalid: '⚠️', error: '💥' };
const lines = [
  `# sandbox 執行結果（${stamp}）`, '',
  `image ${tag} ｜ ${sets.length} 套 ｜ 總時間 ${Math.floor(total / 60)}m${Math.round(total % 60)}s`, '',
  '| 結果 | 情境 | seed | 套 | 訂單（已付款） | 秒 | 報告 |', '|---|---|---|---|---|---|---|',
  ...results.map((r) => `| ${icon[r.status]} | ${r.title} | ${r.seed} | ${r.setNo} | ${r.orders ? `${r.orders.total}（${r.orders.paid}）` : '-'} | ${r.timings.total.toFixed(0)} | ${r.dir}/report.md |`),
];
writeFileSync(join(runDir, 'summary.md'), lines.join('\n') + '\n');
writeFileSync(join(runDir, 'summary.json'), JSON.stringify({ stamp, tag, total, results: results.map(({ evidence, ...r }) => r) }, null, 2));
console.log('\n' + lines.join('\n'));
for (const r of results.filter((x) => x.status !== 'passed')) console.log(`\n${icon[r.status]} ${r.scenario}：${join(runDir, r.dir, 'report.md')}`);

process.exit(results.every((r) => r.status === 'passed') ? 0 : 1);
