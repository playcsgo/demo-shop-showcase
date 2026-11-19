// sandbox（docker compose 第 N 套）轉接層：跟 collect/k8s.mjs 同一組函式，run.mjs 依 --mode 選一個
//   重新部署（build＋重建容器）→ 重建環境 → 套用廠商設定 → 每 5 秒取樣 → 跑 k6 → 等消化完 → 不變式
// 每個服務一個容器、不會擴充：量的是「一份」服務的處理能力
// 叢集內的 HTTP（SQS、FPM 狀態）跟 K8s 一樣借 partners 容器的 node 執行（同一段程式，IN_CLUSTER）
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUEUES, SandboxSet, sh } from '../../sandbox/lib/sets.mjs';
import { NODE_PORT, k6Output } from './k6-prometheus.mjs';
import { IN_CLUSTER, sleep } from './k8s.mjs';

export { sleep };
export const MODES = { 'dev-container': 'docker compose，每個服務 1 個容器（不擴充）' };

const N = Number(process.env.SANDBOX_SET ?? 1);
let set = new SandboxSet(N, null);
const container = (svc) => `${set.project}-${svc}-1`;

function docker(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args.slice(0, 3).join(' ')} 失敗：${stderr || err.message}`.slice(0, 2000)));
      else resolve(stdout);
    });
  });
}
const inside = async (req) => JSON.parse(await docker(['exec', container('partners'), 'node', '-e', IN_CLUSTER, JSON.stringify(req)]));

/** 重新部署：程式改過就重新 build image，容器換成新的（NO_BUILD=1 沿用現有的 image；scripts/sandbox.sh up N；Datadog 照這一套存下來的設定） */
export async function deploy(log) {
  log(`重新部署 ${set.project}（build image → 重建容器）`);
  const release = await set.lock('loadtest', log);
  const r = await sh('scripts/sandbox.sh', ['up', String(N), ...(process.env.NO_BUILD ? ['--no-build'] : [])], { env: { SANDBOX_LOCK_HELD: set.project }, timeoutMs: 30 * 60_000 });
  if (r.code !== 0) { release(); throw new Error(`${set.project} 部署失敗：\n${r.out.slice(-2000)}`); }
  // compose 指令要帶 image 的 tag：從正在跑的容器讀
  const image = (await docker(['inspect', '-f', '{{.Config.Image}}', container('core-api')])).trim();
  set = new SandboxSet(N, image.split(':').pop());
  log(`${set.project} 就緒（image ${set.tag}）`);
  return release;
}

/** 回到乾淨狀態：停背景程式 → 清 SQS、Redis → 資料庫重建＋種子資料（含壓測帳號、分桶）→ partners 清空 → 背景程式回來 */
export async function reset({ customers, buckets, log }) {
  log(`重建環境（${customers} 個壓測帳號、庫存分 ${buckets} 桶）`);
  await set.reset({ CUSTOMERS: customers, BUCKETS: buckets }, 1);
}

export const partners = (method, path, body) => set.partners(method, path, body);
export const sqsBacklog = async (queues = QUEUES) => (await inside({ sqs: queues })).sqs;

/** sandbox 沒有擴充，模式不用切換 */
export async function prepareMode() { return async () => {}; }

// ───────── 取樣 ─────────
// 單執行緒的服務一個容器上限 1 核；PHP-FPM、MySQL、ProxySQL 多程序 → 不算單一上限（跟 K8s 一樣）
const singleThread = (name) => /^(hub|bff-gateway|partners|localstack|redis|core-(worker|relay|scheduler))$/.test(name);
const memMi = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB)$/);
  return m ? Number(m[1]) * { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]] : 0;
};
let cachedCpus = null;
let fpmMax = null;

/** 取一次樣：各容器的 CPU／記憶體、FPM、MySQL、SQS、整台電腦（所有容器加總） */
export async function sample() {
  cachedCpus ??= Number((await docker(['info', '--format', '{{.NCPU}}'])).trim());
  fpmMax ??= Number((await docker(['exec', container('core-api'), 'printenv', 'FPM_MAX_CHILDREN']).catch(() => '')).trim()) || null;
  const [stats, db, ins] = await Promise.all([
    docker(['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}']),
    // root：看「等鎖的交易」要 PROCESS 權限，demo 帳號沒有（sandbox 的 root 密碼是 root，只在本機）
    docker(['exec', container('mysql'), 'mysql', '-uroot', '-proot', '-N', '-B', '-e', "SHOW GLOBAL STATUS LIKE 'Threads_connected'; SELECT 'max', @@max_connections; SELECT 'locks', COUNT(*) FROM information_schema.innodb_trx WHERE trx_state='LOCK WAIT'; SELECT 'outbox', COUNT(*) FROM demo.outbox_messages WHERE status='PENDING'"])
      .then((out) => out.trim().split('\n').map((l) => l.split('\t'))).catch(() => null),
    inside({ sqs: QUEUES, fpm: ['core-nginx'] }).catch(() => ({})),
  ]);
  const services = {};
  let hostCpu = 0;
  for (const line of stats.trim().split('\n')) {
    const [name, cpu, mem] = line.split('\t');
    const cores = Number(String(cpu).replace('%', '')) / 100 || 0;
    hostCpu += cores;   // 整台電腦：這台機器上所有容器（含其他專案、K8s 節點）
    if (!name.startsWith(`${set.project}-`)) continue;
    const svc = name.slice(set.project.length + 1).replace(/-\d+$/, '');
    const used = String(mem).split('/')[0];
    services[svc] = {
      pods: 1, maxPods: null,
      cpuM: Math.round(cores * 1000), cpuCapM: singleThread(svc) ? 1000 : null,
      memMi: Math.round(memMi(used)), memLimitMi: null,   // 沒設記憶體上限：docker stats 顯示的是整台虛擬機的記憶體，不算
    };
  }
  const row = (k) => db?.find((r) => r[0] === k)?.[1];
  return {
    t: Date.now(),
    services,
    fpm: ins.fpm?.length ? { busy: ins.fpm[0].active, max: fpmMax ?? ins.fpm[0].total, queue: ins.fpm[0].queue } : null,
    db: db ? { conns: Number(row('Threads_connected')), maxConns: Number(row('max')), lockWaits: Number(row('locks')) } : null,
    // outbox（core 還沒送出的指令）跟 SQS 佇列放在一起算積壓
    sqs: ins.sqs ? { ...ins.sqs, ...(row('outbox') != null ? { outbox: Number(row('outbox')) } : {}) } : null,
    host: { cpuUsed: Math.round(hostCpu * 10) / 10, cpus: cachedCpus },
  };
}

/** 每 intervalMs 取一次樣，直到 stop()；取樣失敗只記下來，不中斷壓測 */
export function startSampler({ intervalMs = 5000, log }) {
  const samples = [];
  const errors = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const at = Date.now();
      try { samples.push(await sample()); } catch (e) { errors.push(e.message); if (errors.length <= 3) log(`取樣失敗：${e.message.slice(0, 200)}`); }
      await sleep(Math.max(0, intervalMs - (Date.now() - at)));
    }
  })();
  return { samples, errors, stop: async () => { running = false; await loop; } };
}

// ───────── k6 ─────────
/** k6 跑在這一套的 docker 網路裡，直接打 core-nginx；回傳 { t0, result } */
export async function runK6(env, { root, log }) {
  // levels.js 用 import './shop.js'：兩個檔案放進同一個資料夾再掛進去（K8s 是放進同一個 ConfigMap）
  const dir = mkdtempSync(join(tmpdir(), 'k6-'));
  copyFileSync(join(root, 'sandbox/k6/shop.js'), join(dir, 'shop.js'));
  copyFileSync(join(root, 'deploy/k6/levels.js'), join(dir, 'levels.js'));
  // 用 Node 的 IPv4：用名字會先解析成 IPv6，叢集的 NodePort 收不到
  const node = (await docker(['inspect', '-f', '{{.NetworkSettings.Networks.kind.IPAddress}}', 'demo-shop-control-plane']).catch(() => '')).trim();
  const output = await k6Output({ url: node && `http://${node}:${NODE_PORT}/api/v1/write`, env: `sandbox-${String(N).padStart(2, '0')}` });
  const envArgs = Object.entries({ BASE: 'http://core-nginx/api/v1', ...output.env, ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  let t0 = null, result = null;
  await new Promise((resolve, reject) => {
    const p = spawn('docker', ['run', '--rm', '--network', set.network, ...(output.args.length ? ['--network', 'kind'] : []), '-v', `${dir}:/scripts:ro`, ...envArgs, 'grafana/k6:2.3.0', 'run', '--quiet', ...output.args, '/scripts/levels.js']);
    let buf = '';
    const onData = (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m0 = line.match(/K6_T0 (\d+)/);
        if (m0) { t0 = Number(m0[1]); log('k6 開始'); continue; }
        if (line.startsWith('K6_RESULT ')) { result = JSON.parse(line.slice(10)); continue; }
        if (/level=(error|warning)/.test(line)) log(`k6：${line.slice(0, 300)}`);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', () => (result ? resolve() : reject(new Error('k6 沒有輸出結果（K6_RESULT）'))));
  });
  return { t0, result };
}

// ───────── 結束之後 ─────────
const reconcile = async () => (await set.artisanJson('reconcile:check', '--json')).data;

// 不等的：包裹配送中（等物流把狀態一步一步送完，跟我們的伺服器無關；壓測的終點是「交給物流」）
const IGNORE_IN_FLIGHT = ['shipments_in_transit'];

/** 等背景消化完：SQS 全空、沒有在途的付款與 outbox（最多 timeoutMs） */
export async function drain({ log, timeoutMs = 15 * 60_000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const backlog = Object.entries(await sqsBacklog()).filter(([, n]) => n > 0);
    const busy = Object.entries((await reconcile()).in_flight).filter(([k, n]) => n > 0 && !IGNORE_IN_FLIGHT.includes(k));
    if (!backlog.length && !busy.length) return { seconds: Math.round((Date.now() - started) / 1000) };
    log(`等消化：${[...backlog.map(([q, n]) => `${q} ${n}`), ...busy.map(([k, n]) => `${k} ${n}`)].join('、')}`);
    await sleep(15_000);
  }
  return { seconds: null };
}

/** 不變式：php artisan reconcile:check --json */
export async function invariants() {
  const r = await reconcile();
  return Object.entries(r.checks).map(([name, c]) => ({ name, pass: c.ok, detail: c.ok ? '' : `${c.count} 筆${c.detail ? `：${c.detail}` : ''}${c.order_nos?.length ? `（例：${c.order_nos.slice(0, 3).join('、')}）` : ''}` }));
}

export async function orderCount() {
  return Number((await set.sql('SELECT COUNT(*) FROM orders'))[0]?.[0] ?? 0);
}

/** Datadog 的狀態（看 core-api 容器的環境變數）：有沒有送指標、有沒有開 APM trace */
export async function datadog() {
  const v = async (k) => (await docker(['exec', container('core-api'), 'printenv', k]).catch(() => '')).trim();
  return { metrics: Boolean(await v('DD_AGENT_HOST')), apm: (await v('DD_TRACE_ENABLED')) === 'true', env: (await v('DD_ENV')) || null };
}

export async function environment() {
  cachedCpus ??= Number((await docker(['info', '--format', '{{.NCPU}}'])).trim());
  return { 環境: `docker compose ${set.project}（每個服務 1 個容器）`, 核心: `${cachedCpus} 核（OrbStack 虛擬機，所有容器共用）` };
}

/** core-api 的執行方式：compose.sandbox.yaml 只開 PHP-FPM；Go 版的 image 帶 CORE_RUNTIME=go（services/core-go/Dockerfile） */
export async function runtime() {
  const declared = (await docker(['exec', container('core-api'), 'printenv', 'CORE_RUNTIME']).catch(() => '')).trim();
  return declared === 'go' ? 'go' : 'fpm';
}

/** Loki：經過這一套的 Grafana 查（不用 port-forward） */
export async function lokiTunnel() {
  return { url: `${set.grafanaUrl}/api/datasources/proxy/uid/loki`, close: () => {} };
}
