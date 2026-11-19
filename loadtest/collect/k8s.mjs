// K8s（kind）轉接層：重建環境、套用廠商設定、預先開滿／還原、每 5 秒取樣、跑 k6、等消化完、檢查不變式
// 全部透過 kubectl；叢集裡要打的 HTTP（SQS、各 Pod 的 FPM 狀態、partners）借 partners 這個 Node.js Pod 執行
import { execFile, spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { K8S_URL, k6Output } from './k6-prometheus.mjs';

export const NS = 'demo-shop';
const CTX = 'kind-demo-shop';
export const QUEUES = ['core-commands', 'payment-commands', 'payment-reconcile-commands', 'logistics-commands', 'clinic-commands', 'line-commands', 'integration-events', 'analytics-events'];
// 自己沒有被 KEDA／HPA 管、但會動資料的背景程式：重建時要先停
const PLAIN_WORKERS = ['core-scheduler'];

// 沒設 CPU limit（刻意的：避免被節流），所以「CPU 滿了」要看執行環境本身的上限：
//   一個 Pod 只跑一支單執行緒程式的（Node.js 的 hub／bff／partners、LocalStack、Redis、
//   core-worker／relay／scheduler 這種 artisan 常駐程式）→ 一顆核心就是上限
//   PHP-FPM（core-api）、MySQL、ProxySQL 多程序／多執行緒 → 沒有單一 Pod 上限，看 FPM 忙碌數和整台電腦
const singleThread = (name) => /^(hub-|bff$|partners$|localstack$|redis$|core-(worker|relay|scheduler)$)/.test(name);

/** 執行 kubectl，回傳 stdout；失敗丟例外 */
export function kube(args, { input, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile('kubectl', ['--context', CTX, ...args], { maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`kubectl ${args.slice(0, 4).join(' ')} 失敗：${stderr || err.message}`.slice(0, 2000)));
      else resolve(stdout);
    });
    if (input) p.stdin.end(input);
  });
}
const kjson = async (args) => JSON.parse(await kube([...args, '-o', 'json']));

// ───────── 叢集內的 HTTP：借 partners Pod 的 node 執行 ─────────
// LocalStack 從認證標頭讀區域（不驗簽名），佇列都建在 ap-northeast-1
export const IN_CLUSTER = `
const req = JSON.parse(process.argv[1]);
const auth = 'AWS4-HMAC-SHA256 Credential=test/20260101/ap-northeast-1/sqs/aws4_request, SignedHeaders=host, Signature=x';
const sqs = (target, body) => fetch('http://localstack:4566/', { method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.0', authorization: auth, 'x-amz-target': 'AmazonSQS.' + target }, body: JSON.stringify(body) }).then((r) => r.json());
const url = (q) => 'http://sqs.ap-northeast-1.localhost.localstack.cloud:4566/000000000000/' + q;
(async () => {
  const out = {};
  if (req.sqs) {
    out.sqs = {};
    await Promise.all(req.sqs.map(async (q) => {
      const a = (await sqs('GetQueueAttributes', { QueueUrl: url(q), AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] })).Attributes ?? {};
      out.sqs[q] = Number(a.ApproximateNumberOfMessages ?? 0) + Number(a.ApproximateNumberOfMessagesNotVisible ?? 0);
    }));
  }
  if (req.purge) await Promise.all(req.purge.map((q) => sqs('PurgeQueue', { QueueUrl: url(q) })));
  if (req.fpm) {
    const all = await Promise.all(req.fpm.map((ip) => fetch('http://' + ip + '/fpm-status?json', { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null)));
    out.fpm = all.filter(Boolean).map((s) => ({ active: s['active processes'], total: s['total processes'], queue: s['listen queue'] }));
  }
  if (req.partners) {
    const r = await fetch('http://127.0.0.1:4000' + req.partners.path, { method: req.partners.method, headers: { 'content-type': 'application/json' }, body: req.partners.method === 'GET' ? undefined : JSON.stringify(req.partners.body ?? {}) });
    if (!r.ok) throw new Error('partners ' + req.partners.method + ' ' + req.partners.path + ' → ' + r.status + ' ' + (await r.text()));
    out.partners = await r.json();
  }
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e.message); process.exit(1); });
`;
const inCluster = async (req) => JSON.parse(await kube(['-n', NS, 'exec', 'deploy/partners', '--', 'node', '-e', IN_CLUSTER, JSON.stringify(req)]));

export const partners = async (method, path, body) => (await inCluster({ partners: { method, path, body } })).partners;
export const sqsBacklog = async (queues = QUEUES) => (await inCluster({ sqs: queues })).sqs;

const artisan = (...args) => kube(['-n', NS, 'exec', 'deploy/core-api', '-c', 'php', '--', 'php', 'artisan', ...args], { timeoutMs: 600_000 });

async function mysql(sql) {
  const out = await kube(['-n', NS, 'exec', 'mysql-0', '--', 'sh', '-c', `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e "${sql}" 2>/dev/null`]);
  return out.trim().split('\n').map((l) => l.split('\t'));
}

// ───────── 重建環境 ─────────
/** 回到乾淨狀態：停背景程式 → 清 SQS、Redis → 資料庫重建＋種子資料（含壓測帳號、分桶）→ partners 清空 → 背景程式回來 */
export async function reset({ customers, buckets, log }) {
  const sos = (await kjson(['-n', NS, 'get', 'scaledobject'])).items;
  const scaled = sos.map((s) => s.metadata.name);
  const pausedBefore = Object.fromEntries(sos.map((s) => [s.metadata.name, s.metadata.annotations?.['autoscaling.keda.sh/paused-replicas']]));   // 固定模式：重建完要回到原本的暫停
  log(`停背景程式（KEDA 暫停 ${scaled.length} 個、${PLAIN_WORKERS.join('、')} 縮到 0）`);
  for (const s of scaled) await kube(['-n', NS, 'annotate', 'scaledobject', s, 'autoscaling.keda.sh/paused-replicas=0', '--overwrite']);
  const plain = {};
  for (const d of PLAIN_WORKERS) {
    plain[d] = (await kjson(['-n', NS, 'get', 'deploy', d])).spec.replicas || 1;
    await kube(['-n', NS, 'scale', 'deploy', d, '--replicas=0']);
  }
  for (const d of [...scaled, ...PLAIN_WORKERS]) await kube(['-n', NS, 'wait', '--for=delete', 'pod', '-l', `app=${d}`, '--timeout=180s']).catch(() => {});

  log('清 SQS、Redis');
  await inCluster({ purge: QUEUES.flatMap((q) => [q, `${q}-dlq`]) });
  await kube(['-n', NS, 'exec', 'deploy/redis', '--', 'redis-cli', 'FLUSHALL']);

  log(`資料庫重建（${customers} 個壓測帳號、庫存分 ${buckets} 桶）`);
  await artisan('migrate:fresh', '--seed', '--force');
  await artisan('sandbox:data', `--customers=${customers}`, '--stock=1000000', `--buckets=${buckets}`);
  await partners('POST', '/admin/reset');

  log('背景程式回來');
  for (const s of scaled) await kube(['-n', NS, 'annotate', 'scaledobject', s, pausedBefore[s] === undefined ? 'autoscaling.keda.sh/paused-replicas-' : `autoscaling.keda.sh/paused-replicas=${pausedBefore[s]}`, '--overwrite']);
  for (const [d, n] of Object.entries(plain)) await kube(['-n', NS, 'scale', 'deploy', d, `--replicas=${n}`]);
  await waitReady(log);
  const left = Object.values(await sqsBacklog()).reduce((a, b) => a + b, 0);
  if (left) throw new Error(`重建後 SQS 還有 ${left} 則（PurgeQueue 可能被擋：同一條佇列 60 秒內只能清一次）`);
}

/** 等每個 Deployment 的 Pod 都 Ready（至少到 spec.replicas） */
export async function waitReady(log, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const ds = (await kjson(['-n', NS, 'get', 'deploy'])).items;
    const notReady = ds.filter((d) => (d.status.readyReplicas ?? 0) < (d.spec.replicas ?? 0)).map((d) => `${d.metadata.name} ${d.status.readyReplicas ?? 0}/${d.spec.replicas}`);
    if (!notReady.length) return;
    if (Date.now() > until) throw new Error(`等不到 Pod Ready：${notReady.join('、')}`);
    await sleep(3000);
  }
}

// ───────── 模式 ─────────
// k8s-single：可以擴充的服務全部固定 1 個 Pod｜k8s-auto：HPA／KEDA 自己擴（從 min 開始）
// k8s-max：開跑前直接開到上限（還是可以縮回去之前就量完）｜k8s-fixed4：全部固定 4 個 Pod
// k8s-go-best：Go 版的理論最優解（只有 CORE_RUNTIME=go 能切）：其他照 k8s-max，下面 GO_BEST 這幾個另外設
// 「可以擴充的服務」：有 HPA／KEDA 的（core-relay 看 outbox 積壓、hub-api 看 CPU 也有）
// 不動：core-scheduler（排程同時只能一個）、partners（模擬廠商，狀態在記憶體）、MySQL、Redis、LocalStack、storefront（不在測試路徑上）
export const MODES = {
  'k8s-single': '每個服務固定 1 個 Pod（不自動擴充）',
  'k8s-auto': '自動擴充（HPA＋KEDA，從最少的 Pod 數開始）',
  'k8s-max': '開跑前直接開到上限（HPA／KEDA 的 max）',
  'k8s-fixed4': '每個服務固定 4 個 Pod（不自動擴充）',
  'k8s-go-best': 'Go 調校：core-api 固定 4 個×每個 20 條連線、relay 8 個，其他開到上限（只限 Go）',
};
const ALIASES = { 'k8s-autoscale': 'k8s-auto', 'k8s-prepared': 'k8s-max' };   // 舊的名字（之前的 run.json）
export const modeName = (m) => ALIASES[m] ?? m;
const FIXED = { 'k8s-single': 1, 'k8s-fixed4': 4 };
const PLAIN_SCALABLE = [];   // 以前是 core-relay、hub-api；現在一個交給 KEDA（outbox 積壓）、一個交給 HPA（CPU）

const ORIG = 'demo.loadtest/original';   // 切換前的設定（JSON），切回 k8s-auto 時照它還原
const PAUSED = 'autoscaling.keda.sh/paused-replicas';
// k8s-go-best 的差異（從 20261111-1918 直連那場的瓶頸推出來，還沒驗證）：
//   core-api：Go 一個 Pod 就能同時處理很多請求，不用靠多開 Pod；連線總數一樣 80，Pod 少一半，CPU 留給 MySQL
//   core-relay：一次只送一批、時間都在等 SQS（CPU 1%），100／秒時 outbox 最先積壓 → 多開
// DB_MAX_OPEN 寫在 core-api 的 Deployment（會重啟 Pod）；MODE 標記在 Deployment 上，切到別的模式時拿掉、DB_MAX_OPEN 也拿掉
const GO_BEST = { apiPods: 4, dbMaxOpen: 20, relayPods: 8 };
const MODE = 'demo.loadtest/mode';

/** 現在是哪個模式：看 HPA、KEDA 的設定（不是記住按過哪個） */
export async function currentMode() {
  if ((await kjson(['-n', NS, 'get', 'deploy', 'core-api'])).metadata.annotations?.[MODE] === 'k8s-go-best') return 'k8s-go-best';
  const hpas = (await kjson(['-n', NS, 'get', 'hpa'])).items.filter((h) => !h.metadata.name.startsWith('keda-hpa-'));
  const sos = (await kjson(['-n', NS, 'get', 'scaledobject'])).items;
  const paused = sos.map((x) => x.metadata.annotations?.[PAUSED]);
  if (paused.every((v) => v !== undefined) && new Set(paused).size === 1) {
    const n = Number(paused[0]);
    if (hpas.every((h) => h.spec.minReplicas === n && h.spec.maxReplicas === n)) return Object.entries(FIXED).find(([, v]) => v === n)?.[0] ?? `k8s-fixed${n}`;
  }
  if (paused.every((v) => v === undefined) && hpas.every((h) => h.spec.minReplicas === h.spec.maxReplicas) && sos.every((x) => x.spec.minReplicaCount === x.spec.maxReplicaCount)) return 'k8s-max';
  // 沒有任何物件記著「原本的設定」＝沒動過＝自動；有動過、又不是上面幾種＝手動調過個別服務
  const deps = await Promise.all(PLAIN_SCALABLE.map((d) => kjson(['-n', NS, 'get', 'deploy', d])));
  return [...hpas, ...sos, ...deps].some((x) => x.metadata.annotations?.[ORIG] || x.metadata.annotations?.[PAUSED]) ? 'custom' : 'k8s-auto';
}

/** 可以調 Pod 數的服務：現在幾個、是不是固定住（手動或固定模式；null＝自動擴充或照 Deployment 原本的數量） */
export async function scalable() {
  const hpas = (await kjson(['-n', NS, 'get', 'hpa'])).items.filter((h) => !h.metadata.name.startsWith('keda-hpa-'));
  const sos = (await kjson(['-n', NS, 'get', 'scaledobject'])).items;
  const deps = Object.fromEntries((await kjson(['-n', NS, 'get', 'deploy'])).items.map((d) => [d.metadata.name, d]));
  const replicas = (n) => ({ ready: deps[n]?.status.readyReplicas ?? 0, desired: deps[n]?.spec.replicas ?? 0 });
  return [
    ...hpas.map((h) => ({ name: h.spec.scaleTargetRef.name, by: 'HPA', pinned: h.metadata.annotations?.[ORIG] && h.spec.minReplicas === h.spec.maxReplicas ? h.spec.minReplicas : null, ...replicas(h.spec.scaleTargetRef.name) })),
    ...sos.map((x) => ({ name: x.spec.scaleTargetRef.name, by: 'KEDA', pinned: x.metadata.annotations?.[PAUSED] !== undefined ? Number(x.metadata.annotations[PAUSED]) : x.metadata.annotations?.[ORIG] && x.spec.minReplicaCount === x.spec.maxReplicaCount ? x.spec.minReplicaCount : null, ...replicas(x.spec.scaleTargetRef.name) })),
    ...PLAIN_SCALABLE.map((d) => ({ name: d, by: '沒有自動擴充', pinned: deps[d]?.metadata.annotations?.[ORIG] ? deps[d].spec.replicas : null, ...replicas(d) })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** 手動把一個服務固定成 n 個 Pod（其他服務不動）；原本的設定記在 annotation，切回 k8s-auto 時一起還原 */
export async function setReplicas(name, n) {
  n = Math.max(1, Math.round(Number(n)));
  const remember = async (kind, obj, current) => {
    if (!obj.metadata.annotations?.[ORIG]) await kube(['-n', NS, 'annotate', kind, obj.metadata.name, `${ORIG}=${JSON.stringify(current)}`, '--overwrite']);
  };
  const hpa = (await kjson(['-n', NS, 'get', 'hpa'])).items.find((h) => !h.metadata.name.startsWith('keda-hpa-') && h.spec.scaleTargetRef.name === name);
  if (hpa) {
    await remember('hpa', hpa, { minReplicas: hpa.spec.minReplicas ?? 1, maxReplicas: hpa.spec.maxReplicas });
    return kube(['-n', NS, 'patch', 'hpa', hpa.metadata.name, '--type=merge', '-p', JSON.stringify({ spec: { minReplicas: n, maxReplicas: n } })]);
  }
  const so = (await kjson(['-n', NS, 'get', 'scaledobject'])).items.find((x) => x.spec.scaleTargetRef.name === name);
  if (so) {
    await remember('scaledobject', so, { minReplicaCount: so.spec.minReplicaCount ?? 0 });
    return kube(['-n', NS, 'annotate', 'scaledobject', so.metadata.name, `${PAUSED}=${n}`, '--overwrite']);   // KEDA 暫停在 n 個
  }
  if (!PLAIN_SCALABLE.includes(name)) throw new Error(`${name} 不能調 Pod 數（只能調：有 HPA／KEDA 的服務、${PLAIN_SCALABLE.join('、')}）`);
  const d = await kjson(['-n', NS, 'get', 'deploy', name]);
  await remember('deploy', d, { replicas: d.spec.replicas ?? 1 });
  return kube(['-n', NS, 'scale', 'deploy', name, `--replicas=${n}`]);
}

/**
 * 切換模式，之後一直維持（UI 的按鈕、壓測開跑前都用這個）：
 *   第一次離開 k8s-auto 時，把原本的設定記在各物件的 annotation（demo.loadtest/original），切回 k8s-auto 時照它還原
 *   之後 bootstrap（helm upgrade）會把 HPA、KEDA 改回 chart 的設定＝k8s-auto
 */
export async function setMode(mode, log = () => {}) {
  mode = modeName(mode);
  if (!MODES[mode]) throw new Error(`不認識的模式：${mode}（${Object.keys(MODES).join('、')}）`);
  const best = mode === 'k8s-go-best';
  if (best && (await runtime()) !== 'go') throw new Error('k8s-go-best 只能在 Go 版用（scripts/k8s.sh runtime go）');
  const max = mode === 'k8s-max' || best;
  const hpas = (await kjson(['-n', NS, 'get', 'hpa'])).items.filter((h) => !h.metadata.name.startsWith('keda-hpa-'));
  const sos = (await kjson(['-n', NS, 'get', 'scaledobject'])).items;
  const deps = await Promise.all(PLAIN_SCALABLE.map((d) => kjson(['-n', NS, 'get', 'deploy', d])));
  const patch = (kind, name, spec) => kube(['-n', NS, 'patch', kind, name, '--type=merge', '-p', JSON.stringify({ spec })]);
  const annotate = (kind, name, kv) => kube(['-n', NS, 'annotate', kind, name, kv, '--overwrite']);
  // 原本的設定：有記過就用記的，沒有就是現在的（還沒切換過）並記下來
  const original = async (kind, obj, current) => {
    const saved = obj.metadata.annotations?.[ORIG];
    if (saved) return JSON.parse(saved);
    if (mode !== 'k8s-auto') await annotate(kind, obj.metadata.name, `${ORIG}=${JSON.stringify(current)}`);
    return current;
  };
  const n = FIXED[mode];
  log(`K8s 模式 → ${mode}（${MODES[mode]}）`);
  for (const h of hpas) {
    const o = await original('hpa', h, { minReplicas: h.spec.minReplicas ?? 1, maxReplicas: h.spec.maxReplicas });
    const pods = best && h.spec.scaleTargetRef.name === 'core-api' ? GO_BEST.apiPods : max ? o.maxReplicas : n;
    await patch('hpa', h.metadata.name, mode === 'k8s-auto' ? o : { minReplicas: pods, maxReplicas: pods });
  }
  for (const x of sos) {
    // maxReplicaCount 也記：k8s-go-best 會把 relay 的上限調高（舊的紀錄沒有這一欄 → 用現在的）
    const o = await original('scaledobject', x, { minReplicaCount: x.spec.minReplicaCount ?? 0, maxReplicaCount: x.spec.maxReplicaCount });
    if (o.maxReplicaCount === undefined) {   // 舊的紀錄：趁還沒被調高，把現在的上限補記進去
      o.maxReplicaCount = x.spec.maxReplicaCount;
      await annotate('scaledobject', x.metadata.name, `${ORIG}=${JSON.stringify(o)}`);
    }
    const top = best && x.spec.scaleTargetRef.name === 'core-relay' ? GO_BEST.relayPods : o.maxReplicaCount;
    await patch('scaledobject', x.metadata.name, { minReplicaCount: max ? top : o.minReplicaCount, maxReplicaCount: top });
    // 固定：KEDA 暫停在 n 個（KEDA 把 Deployment 調到 n 之後就不再動它）
    await kube(['-n', NS, 'annotate', 'scaledobject', x.metadata.name, n ? `${PAUSED}=${n}` : `${PAUSED}-`, '--overwrite']);
  }
  for (const d of deps) {
    const o = await original('deploy', d, { replicas: d.spec.replicas ?? 1 });
    await kube(['-n', NS, 'scale', 'deploy', d.metadata.name, `--replicas=${n ?? o.replicas}`]);
  }
  const api = await kjson(['-n', NS, 'get', 'deploy', 'core-api']);
  if (best) {
    await kube(['-n', NS, 'set', 'env', 'deploy/core-api', '-c', 'php', `DB_MAX_OPEN=${GO_BEST.dbMaxOpen}`]);
    await kube(['-n', NS, 'annotate', 'deploy', 'core-api', `${MODE}=${mode}`, '--overwrite']);
  } else if (api.metadata.annotations?.[MODE]) {
    await kube(['-n', NS, 'set', 'env', 'deploy/core-api', '-c', 'php', 'DB_MAX_OPEN-']);
    await kube(['-n', NS, 'annotate', 'deploy', 'core-api', `${MODE}-`]);
  }
  if (mode === 'k8s-auto') for (const [kind, list] of [['hpa', hpas], ['scaledobject', sos], ['deploy', deps]]) {
    for (const x of list) if (x.metadata.annotations?.[ORIG]) await kube(['-n', NS, 'annotate', kind, x.metadata.name, `${ORIG}-`]);
  }
}

/** 壓測用：切到這個模式，回傳「切回開跑前的模式」的函式 */
export async function prepareMode(mode, log) {
  mode = modeName(mode);
  const before = await currentMode();
  if (mode !== before) await setMode(mode, log);
  await sleep(20_000);   // HPA／KEDA 要一個週期才會調 replicas
  await waitReady(log);
  return async () => {
    if (mode === before) return;
    const now = await currentMode();
    // 跑到一半有人手動調過（UI 的模式按鈕或個別服務的 ＋／－）：保留他調的，不蓋掉
    if (now !== mode) return log(`跑的時候手動調過 Pod 數（現在是 ${now}），保留，不還原`);
    // 開跑前是手動調過的狀態：沒辦法精確還原，留在這個模式
    if (before === 'custom') return log(`開跑前是手動調過的 Pod 數，沒辦法還原，留在 ${mode}`);
    log(`還原成開跑前的模式（${before}）`);
    await setMode(before, log);
  };
}

// ───────── 取樣 ─────────
const cpuM = (q) => (q.endsWith('n') ? Number(q.slice(0, -1)) / 1e6 : q.endsWith('u') ? Number(q.slice(0, -1)) / 1e3 : q.endsWith('m') ? Number(q.slice(0, -1)) : Number(q) * 1000);
const memMi = (q) => {
  const m = q.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi)?$/);
  return m ? Number(m[1]) * ({ Ki: 1 / 1024, Mi: 1, Gi: 1024 }[m[2]] ?? 1 / 1024 / 1024) : 0;
};

/** 取一次樣：各服務的 Pod 數與每個 Pod 的 CPU／記憶體、FPM、MySQL、SQS、整台電腦 */
export async function sample() {
  const [podMetrics, nodeMetrics, objs, db, nodes] = await Promise.all([
    kube(['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${NS}/pods`]).then(JSON.parse),
    kube(['get', '--raw', '/apis/metrics.k8s.io/v1beta1/nodes']).then(JSON.parse),
    kjson(['-n', NS, 'get', 'deploy,statefulset,hpa,pod']),
    mysql("SHOW GLOBAL STATUS LIKE 'Threads_connected'; SELECT 'max', @@max_connections; SELECT 'locks', COUNT(*) FROM information_schema.innodb_trx WHERE trx_state='LOCK WAIT'; SELECT 'outbox', COUNT(*) FROM demo.outbox_messages WHERE status='PENDING'").catch(() => null),
    hostCpus(),
  ]);
  const items = objs.items;
  const pods = items.filter((x) => x.kind === 'Pod' && x.status.phase === 'Running');
  const fpmIps = pods.filter((p) => p.metadata.labels?.app === 'core-api' && p.status.podIP).map((p) => p.status.podIP);
  const inside = await inCluster({ sqs: QUEUES, fpm: fpmIps }).catch(() => ({}));

  const maxPods = {};
  for (const h of items.filter((x) => x.kind === 'HorizontalPodAutoscaler')) maxPods[h.spec.scaleTargetRef.name] = h.spec.maxReplicas;
  const usage = {};
  for (const m of podMetrics.items) {
    const app = m.metadata.labels?.app;
    if (!app || app === 'k6-load' || m.metadata.labels?.['job-name']) continue;
    (usage[app] ??= []).push({ cpu: m.containers.reduce((a, c) => a + cpuM(c.usage.cpu), 0), mem: m.containers.reduce((a, c) => a + memMi(c.usage.memory), 0) });
  }
  const services = {};
  for (const w of items.filter((x) => x.kind === 'Deployment' || x.kind === 'StatefulSet')) {
    const name = w.metadata.name;
    const u = usage[name] ?? [];
    const cs = w.spec.template.spec.containers;
    const limitMem = cs.reduce((a, c) => a + memMi(c.resources?.limits?.memory ?? '0'), 0);
    const limitCpu = cs.reduce((a, c) => a + (c.resources?.limits?.cpu ? cpuM(c.resources.limits.cpu) : 0), 0);
    services[name] = {
      pods: w.status.readyReplicas ?? 0,
      maxPods: maxPods[name] ?? null,   // 只有 HPA／KEDA 管的才有上限；固定副本數的不算「擴到上限」
      cpuM: u.length ? Math.round(u.reduce((a, x) => a + x.cpu, 0) / u.length) : 0,
      cpuCapM: limitCpu || (singleThread(name) ? 1000 : null),
      memMi: u.length ? Math.round(u.reduce((a, x) => a + x.mem, 0) / u.length) : 0,
      memLimitMi: limitMem || null,
    };
  }
  const fpmMaxPerPod = Number(items.find((x) => x.kind === 'Deployment' && x.metadata.name === 'core-api')?.spec.template.spec.containers.find((c) => c.name === 'php')?.env?.find((e) => e.name === 'FPM_MAX_CHILDREN')?.value ?? 0) || null;
  const row = (k) => db?.find((r) => r[0] === k)?.[1];
  return {
    t: Date.now(),
    services,
    fpm: inside.fpm ? { busy: inside.fpm.reduce((a, s) => a + s.active, 0), max: inside.fpm.reduce((a, s) => a + (fpmMaxPerPod ?? s.total), 0), queue: inside.fpm.reduce((a, s) => a + s.queue, 0) } : null,
    db: db ? { conns: Number(row('Threads_connected')), maxConns: Number(row('max')), lockWaits: Number(row('locks')) } : null,
    // outbox（core 還沒送出的指令）跟 SQS 佇列放在一起算積壓：relay 送不及也是一種「消化不及」
    sqs: inside.sqs ? { ...inside.sqs, ...(row('outbox') != null ? { outbox: Number(row('outbox')) } : {}) } : null,
    host: { cpuUsed: Math.round(nodeMetrics.items.reduce((a, n) => a + cpuM(n.usage.cpu), 0) / 100) / 10, cpus: nodes },
  };
}

// kind 的節點都是同一台虛擬機（OrbStack）裡的容器，共用同一批核心：取一個節點的容量就是整台的核心數
let cachedCpus = null;
async function hostCpus() {
  cachedCpus ??= Number((await kjson(['get', 'nodes'])).items[0]?.status.capacity.cpu ?? cpus().length);
  return cachedCpus;
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
/** 在叢集裡跑 k6（K8s Job），回傳 { t0, result }；log 即時印出 */
export async function runK6(env, { root, log }) {
  const output = await k6Output({ url: K8S_URL, env: 'k8s' });
  const files = ['sandbox/k6/shop.js', 'deploy/k6/levels.js'];
  const cm = await kube(['-n', NS, 'create', 'configmap', 'k6-scripts', ...files.map((f) => `--from-file=${f.split('/').pop()}=${join(root, f)}`), '--dry-run=client', '-o', 'yaml']);
  await kube(['-n', NS, 'apply', '-f', '-'], { input: cm });
  await kube(['-n', NS, 'delete', 'job', 'k6-load', '--ignore-not-found']);
  const job = {
    apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'k6-load', namespace: NS },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: { 'demo/service': 'k6' } },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'k6', image: 'grafana/k6:2.3.0', imagePullPolicy: 'IfNotPresent', args: ['run', '--quiet', ...output.args, '/scripts/levels.js'],
            // 走入口（Traefik）：Service 是建立連線時才分配 Pod，k6 的長連線會黏在最早的 Pod 上，擴充出來的 Pod 分不到流量
            // 走前台的路徑（Traefik → BFF → core）：Host 用前台的 localhost、路徑用 BFF 的 /api，客人實際經過的每一站都算到
            env: Object.entries({ BASE: 'http://traefik.traefik.svc.cluster.local/api', HOST: 'localhost', ...output.env, ...env }).map(([name, value]) => ({ name, value: String(value) })),
            volumeMounts: [{ name: 'scripts', mountPath: '/scripts' }],
          }],
          volumes: [{ name: 'scripts', configMap: { name: 'k6-scripts' } }],
        },
      },
    },
  };
  await kube(['-n', NS, 'apply', '-f', '-'], { input: JSON.stringify(job) });
  await kube(['-n', NS, 'wait', '--for=condition=Ready', 'pod', '-l', 'job-name=k6-load', '--timeout=180s']);
  let t0 = null, result = null;
  await new Promise((resolve, reject) => {
    const p = spawn('kubectl', ['--context', CTX, '-n', NS, 'logs', '-f', 'job/k6-load']);
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m0 = line.match(/K6_T0 (\d+)/);
        if (m0) { t0 = Number(m0[1]); log('k6 開始'); continue; }
        if (line.startsWith('K6_RESULT ')) { result = JSON.parse(line.slice(10)); continue; }
        if (/level=(error|warning)/.test(line)) log(`k6：${line.slice(0, 300)}`);
      }
    });
    p.on('close', () => (result ? resolve() : reject(new Error('k6 沒有輸出結果（K6_RESULT），看 kubectl logs job/k6-load'))));
  });
  return { t0, result };
}

// ───────── 結束之後 ─────────
// 不等的：包裹配送中（等物流把狀態一步一步送完，跟我們的伺服器無關；壓測的終點是「交給物流」）
const IGNORE_IN_FLIGHT = ['shipments_in_transit'];

/** 等背景消化完：SQS 全空、沒有在途的付款與 outbox（最多 timeoutMs） */
export async function drain({ log, timeoutMs = 15 * 60_000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const backlog = Object.entries(await sqsBacklog()).filter(([, n]) => n > 0);
    const inflight = JSON.parse(await artisan('reconcile:check', '--json')).in_flight;
    const busy = Object.entries(inflight).filter(([k, n]) => n > 0 && !IGNORE_IN_FLIGHT.includes(k));
    if (!backlog.length && !busy.length) return { seconds: Math.round((Date.now() - started) / 1000) };
    log(`等消化：${[...backlog.map(([q, n]) => `${q} ${n}`), ...busy.map(([k, n]) => `${k} ${n}`)].join('、')}`);
    await sleep(15_000);
  }
  return { seconds: null };
}

/** 不變式：php artisan reconcile:check --json */
export async function invariants() {
  const r = JSON.parse(await artisan('reconcile:check', '--json'));
  return Object.entries(r.checks).map(([name, c]) => ({ name, pass: c.ok, detail: c.ok ? '' : `${c.count} 筆${c.detail ? `：${c.detail}` : ''}${c.order_nos?.length ? `（例：${c.order_nos.slice(0, 3).join('、')}）` : ''}` }));
}

/** 資料庫裡的訂單數（對照 Loki 收到幾筆 log，看 log 有沒有掉） */
export async function orderCount() {
  return Number((await mysql('SELECT COUNT(*) FROM demo.orders'))[0]?.[0] ?? 0);
}

/** Datadog 的狀態（看 core-api 的環境變數）：有沒有送指標、有沒有開 APM trace */
export async function datadog() {
  const env = (await kjson(['-n', NS, 'get', 'deploy', 'core-api'])).spec.template.spec.containers.flatMap((c) => c.env ?? []);
  const v = (k) => env.find((e) => e.name === k);
  return { metrics: Boolean(v('DD_AGENT_HOST')), apm: v('DD_TRACE_ENABLED')?.value === 'true', env: v('DD_ENV')?.value ?? null };
}

/** 叢集環境的描述（寫進報告） */
export async function environment() {
  const nodes = (await kjson(['get', 'nodes'])).items;
  const ctl = nodes.filter((n) => n.metadata.labels['node-role.kubernetes.io/control-plane'] !== undefined).length;
  return { 節點: `${ctl} 控制＋${nodes.length - ctl} 工作（kind）`, 核心: `${await hostCpus()} 核（節點共用同一台虛擬機）`, 路徑: 'k6 → Traefik → BFF → core' };
}

/** core-api 的執行方式：chart 寫進 php 容器的 CORE_RUNTIME（fpm／octane／go）；舊的部署沒有這個變數，看指令（octane 跑 octane:start） */
export async function runtime() {
  const d = await kjson(['-n', NS, 'get', 'deployment', 'core-api']);
  const php = d.spec.template.spec.containers.find((c) => c.name === 'php');
  const declared = php?.env?.find((e) => e.name === 'CORE_RUNTIME')?.value;
  if (declared) return declared;
  return (php?.command ?? []).includes('octane:start') ? 'octane' : 'fpm';
}

/** Loki 的 port-forward：回傳 { url, close }
 *  本機的埠讓 kubectl 自己挑（固定用 13100 會撞到 docker compose 開發環境的 Loki，查到的是另一份資料，實際踩到） */
export async function lokiTunnel() {
  const p = spawn('kubectl', ['--context', CTX, '-n', 'observability', 'port-forward', 'svc/loki', ':3100'], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.resume();
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('連不到 Loki（port-forward 15 秒沒有回應）')), 15_000);
    p.stdout.on('data', (d) => {
      const m = String(d).match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    p.on('exit', () => reject(new Error('Loki 的 port-forward 結束了')));
  }).catch((e) => { p.kill(); throw e; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 30; i++) {
    if (await fetch(`${url}/ready`).then((r) => r.ok).catch(() => false)) return { url, close: () => p.kill() };
    await sleep(500);
  }
  p.kill();
  throw new Error('Loki 沒有 ready');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
