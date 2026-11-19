#!/usr/bin/env node
// 每個請求打了幾個資料庫查詢（K8s）：比較 PHP-FPM 和 Octane 的差別
//
//   node loadtest/query-count.mjs [--rate 2] [--seconds 50]
//
// 量兩層：
//   ProxySQL 的查詢統計（stats_mysql_query_digest）：Laravel 實際送出的查詢
//   MySQL 的計數器（SHOW GLOBAL STATUS）：MySQL 實際執行的查詢，含 ProxySQL 自己補送的 SET（換後端連線時同步 session 設定）
// 量的時候先停掉背景程式（core-worker、relay、scheduler…），資料庫只會收到 core-api 的查詢；量完放回來
// 用低流量（預設每秒 2 筆）：只算查詢數，不要讓搶鎖、排隊混進來
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { kube, NS, runK6, runtime } from './collect/k8s.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// seed 每次不同：k6 的 Idempotency-Key 由 seed 產生，沿用壓測的 seed 42 會撞到資料庫裡已經有的 key → 結帳變成「重播上次的回應」（回滾），量到的不是真的結帳
const { values: o } = parseArgs({ options: { rate: { type: 'string', default: '2' }, seconds: { type: 'string', default: '50' }, seed: { type: 'string', default: String(Date.now() % 1_000_000) } } });
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (args) => JSON.parse(await kube([...args, '-o', 'json']));

const BACKGROUND = ['core-worker', 'core-relay', 'core-scheduler'];
const proxysqlPods = async () => (await json(['-n', NS, 'get', 'pods', '-l', 'app=proxysql'])).items.map((p) => p.metadata.name);
const proxysql = (pod, sql) => kube(['-n', NS, 'exec', pod, '--', 'mysql', '-uadmin', '-padmin', '-h127.0.0.1', '-P6032', '-N', '-B', '-e', sql]);
const mysqlStatus = async () => {
  const out = await kube(['-n', NS, 'exec', 'mysql-0', '--', 'sh', '-c', 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e "SHOW GLOBAL STATUS" 2>/dev/null']);
  return Object.fromEntries(out.trim().split('\n').map((l) => l.split('\t')).map(([k, v]) => [k, Number(v)]));
};
const COUNTERS = ['Questions', 'Com_select', 'Com_insert', 'Com_update', 'Com_delete', 'Com_set_option', 'Com_begin', 'Com_commit', 'Com_rollback', 'Com_show_variables', 'Com_change_db'];

const rt = await runtime();
log(`core-api 執行方式：${rt}`);

// 停背景程式：KEDA 管的先暫停在 0，其他直接縮到 0
const sos = (await json(['-n', NS, 'get', 'scaledobject'])).items.map((s) => s.metadata.name).filter((n) => BACKGROUND.includes(n));
const plain = BACKGROUND.filter((n) => !sos.includes(n));
const replicas = {};
for (const d of BACKGROUND) replicas[d] = (await json(['-n', NS, 'get', 'deploy', d])).spec.replicas || 1;
log(`停背景程式：${BACKGROUND.join('、')}`);
for (const s of sos) await kube(['-n', NS, 'annotate', 'scaledobject', s, 'autoscaling.keda.sh/paused-replicas=0', '--overwrite']);
for (const d of plain) await kube(['-n', NS, 'scale', 'deploy', d, '--replicas=0']);
for (const d of BACKGROUND) await kube(['-n', NS, 'wait', '--for=delete', 'pod', '-l', `app=${d}`, '--timeout=180s']).catch(() => {});

try {
  // 沒有流量時的雜訊（KEDA 每 5 秒直接查 MySQL、ProxySQL 的健康檢查…）：量 30 秒，之後按時間扣掉
  const n0 = await mysqlStatus();
  await sleep(30_000);
  const n1 = await mysqlStatus();
  const noisePerSec = Object.fromEntries(COUNTERS.map((c) => [c, (n1[c] - n0[c]) / 30]));

  const pods = await proxysqlPods();
  for (const p of pods) await proxysql(p, 'SELECT COUNT(*) FROM stats_mysql_query_digest_reset');   // 讀 _reset 這張表＝清空統計
  const before = await mysqlStatus();
  const started = Date.now();

  log(`k6：每秒 ${o.rate} 筆下單，${o.seconds} 秒`);
  const { result } = await runK6({ ORDER_LEVELS: o.rate, QUERY_RATIO: 0, RAMP: 1, HOLD: o.seconds, IDLE: 0, IDLE_ORDER: 1, MAX_VUS: 50, SEED: o.seed, DIRECT_ONLY: 1 }, { root: ROOT, log });

  const after = await mysqlStatus();
  const elapsed = (Date.now() - started) / 1000;
  const digests = new Map();
  for (const p of pods) {
    const rows = await proxysql(p, 'SELECT digest_text, count_star FROM stats_mysql_query_digest');
    for (const line of rows.trim().split('\n').filter(Boolean)) {
      const [text, n] = line.split('\t');
      digests.set(text, (digests.get(text) ?? 0) + Number(n));
    }
  }

  // HTTP 請求數：k6 每一步的樣本數（含爬升那 1 秒）
  const lv = result.levels.find((l) => l.lvl === '0');
  const steps = Object.fromEntries(Object.entries(lv.steps).filter(([, d]) => d).map(([k, d]) => [k, d.n]));
  const httpRequests = Object.values(steps).reduce((a, b) => a + b, 0);
  const orders = steps.checkout ?? 0;

  const sent = [...digests.values()].reduce((a, b) => a + b, 0);
  const kindOf = (t) => (t.match(/^\s*(\w+)/)?.[1] ?? '?').toUpperCase();
  const byKind = {};
  for (const [t, n] of digests) byKind[kindOf(t)] = (byKind[kindOf(t)] ?? 0) + n;
  const executed = Object.fromEntries(COUNTERS.map((c) => [c, Math.round(after[c] - before[c] - noisePerSec[c] * elapsed)]));

  const per = (n, d) => (d ? (n / d).toFixed(2) : '-');
  console.log(`\n══════ ${rt}（seed ${o.seed}）：${orders} 筆訂單、${httpRequests} 個 HTTP 請求（${JSON.stringify(steps)}）`);
  console.log(`\nLaravel 送出（ProxySQL 統計）：共 ${sent}，每個請求 ${per(sent, httpRequests)}，每筆訂單 ${per(sent, orders)}`);
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${String(n).padStart(7)}　每個請求 ${per(n, httpRequests)}`);
  console.log(`\nMySQL 實際執行（扣掉沒流量時的雜訊）：Questions ${executed.Questions}，每個請求 ${per(executed.Questions, httpRequests)}`);
  for (const c of COUNTERS.slice(1)) if (executed[c]) console.log(`  ${c.padEnd(18)} ${String(executed[c]).padStart(7)}　每個請求 ${per(executed[c], httpRequests)}`);
  console.log('\n次數最多的 15 種查詢：');
  for (const [t, n] of [...digests].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(6)}  ${t.replace(/\s+/g, ' ').slice(0, 130)}`);
} finally {
  log('背景程式放回來');
  for (const s of sos) await kube(['-n', NS, 'annotate', 'scaledobject', s, 'autoscaling.keda.sh/paused-replicas-', '--overwrite']);
  for (const d of plain) await kube(['-n', NS, 'scale', 'deploy', d, `--replicas=${replicas[d]}`]);
}
