#!/usr/bin/env node
// sandbox UI：node sandbox/server.mjs → http://localhost:25000（sandbox port 25000）
//   - 在主機上跑，不放進容器：它要能開關套數（docker），放進容器就得把 docker.sock 交給它（等於 root）
//   - 只聽 127.0.0.1：能下 docker 指令的服務不能讓區網連進來
//   - 真正做事的是 sandbox/cli.mjs（和 CI 同一支），這裡只是按鈕＋看結果
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';
import { currentMode, MODES as K8S_MODES, runtime as k8sRuntime, scalable, setReplicas } from '../loadtest/collect/k8s.mjs';
import { configLabel } from '../loadtest/naming.mjs';
import { runtime as sandboxRuntime } from '../loadtest/collect/sandbox.mjs';
import { allScenarios } from './lib/scenario.mjs';
import { ROOT, sh } from './lib/sets.mjs';

const PORT = Number(process.env.SANDBOX_PORT ?? 25000);
const RUNS = join(ROOT, 'sandbox-runs');
const TESTS = join(ROOT, '..', 'tests');   // 壓測報告（loadtest/run.mjs）放 repo 旁邊的 ../tests
const jobs = [];   // 從 UI 啟動的工作（記憶體裡，重開就清掉；結果本身在 sandbox-runs/）

const portsOf = (nn) => ({ core: `210${nn}`, bff: `220${nn}`, hub: `230${nn}`, partners: `240${nn}`, mysql: `260${nn}`, redis: `270${nn}`, grafana: `280${nn}` });

async function runningSets() {
  const r = await sh('docker', ['ps', '--format', '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Status}}']);
  const sets = {};
  for (const line of r.out.split('\n')) {
    const [project, service, status] = line.split('\t');
    const m = project?.match(/^demo-sb(\d{2})$/);
    if (!m) continue;
    sets[project] ??= { n: Number(m[1]), project, ports: portsOf(m[1]), services: {} };
    sets[project].services[service] = status;
  }
  // 誰正在用（scripts/sandbox.sh 和 cli.mjs 共用的鎖）
  for (const s of Object.values(sets)) {
    const f = join(ROOT, '.sandbox/locks', s.project, 'what');
    s.busy = existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
    const dd = join(ROOT, '.sandbox/datadog', s.project);
    s.datadog = existsSync(dd) ? readFileSync(dd, 'utf8').trim() : '';
    s.apm = !existsSync(`${dd}.apm`) || readFileSync(`${dd}.apm`, 'utf8').trim() !== 'off';   // 沒記過＝開（scripts/sandbox.sh 的預設）
  }
  return Object.values(sets).sort((a, b) => a.n - b.n);
}

function startJob(label, args) {
  const job = { id: jobs.length + 1, label, args, status: 'running', started: Date.now(), lines: [] };
  const p = spawn(args[0], args.slice(1), { cwd: ROOT });
  const onData = (d) => { for (const l of String(d).split('\n')) if (l.trim()) job.lines.push(l); if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400); };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('close', (code) => { job.status = code === 0 ? 'passed' : 'failed'; job.code = code; job.ended = Date.now(); });
  jobs.unshift(job);
  return job;
}

function runsList() {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS).sort().reverse().slice(0, 30).map((stamp) => {
    const f = join(RUNS, stamp, 'summary.json');
    if (!existsSync(f)) return { stamp, results: [] };
    const s = JSON.parse(readFileSync(f, 'utf8'));
    return { stamp, tag: s.tag, total: s.total, results: s.results.map((r) => ({ scenario: r.scenario, title: r.title, kind: r.kind, status: r.status, seed: r.seed, set: r.setNo, orders: r.orders, seconds: r.timings.total, dir: r.dir ?? r.scenario })) };
  });
}

/** 壓測報告（loadtest/run.mjs 的結果）：最新的在前面 */
function testsList() {
  if (!existsSync(TESTS)) return [];
  return readdirSync(TESTS).filter((d) => existsSync(join(TESTS, d, 'run.json'))).sort().reverse().slice(0, 20).map((dir) => {
    const run = JSON.parse(readFileSync(join(TESTS, dir, 'run.json'), 'utf8'));
    const m = run.meta ?? {};
    return { dir, worlds: Object.keys(run.worlds ?? {}), runtime: m.runtime ?? null, buckets: m.buckets, logisticsCallbacks: m.logisticsCallbacks, mode: m.mode, change: m.change, startedAt: m.startedAt, levels: m.levels?.order, directOnly: m.directOnly, apm: m.datadog?.apm ?? null, hasHtml: existsSync(join(TESTS, dir, 'report.html')) };
  });
}

// K8s 的數量單位：3112875m＝3112.875（m 是千分之一），畫面上顯示整數
const qty = (v) => { const m = String(v ?? '').match(/^([\d.]+)(m?)$/); return m ? Math.round(Number(m[1]) / (m[2] ? 1000 : 1)).toLocaleString() : (v ?? '?'); };

// 叢集地圖（scripts/k8s.sh 建的 kind 叢集）：每個 Node 上有哪些 Pod、自動擴充的狀況
const K8S = ['--context', 'kind-demo-shop'];
async function cluster() {
  const [nodes, pods, hpa, top] = await Promise.all([
    sh('kubectl', [...K8S, 'get', 'nodes', '-o', 'json'], { timeoutMs: 8000 }),
    sh('kubectl', [...K8S, '-n', 'demo-shop', 'get', 'pods', '-o', 'json'], { timeoutMs: 8000 }),
    sh('kubectl', [...K8S, '-n', 'demo-shop', 'get', 'hpa', '-o', 'json'], { timeoutMs: 8000 }),
    sh('kubectl', [...K8S, 'top', 'nodes', '--no-headers'], { timeoutMs: 8000 }),
  ]);
  if (nodes.code !== 0) return { available: false };
  const [mode, scale, runtime] = await Promise.all([currentMode().catch(() => null), scalable().catch(() => []), k8sRuntime().catch(() => null)]);
  const usage = Object.fromEntries(top.out.trim().split('\n').filter(Boolean).map((l) => { const c = l.trim().split(/\s+/); return [c[0], { cpu: c[2], mem: c[4] }]; }));
  const podStatus = (p) => {
    if (p.metadata.deletionTimestamp) return 'Terminating';
    const waiting = (p.status.containerStatuses ?? []).find((c) => c.state?.waiting)?.state.waiting.reason;
    if (waiting) return waiting;
    if (p.status.phase === 'Running' && (p.status.containerStatuses ?? []).every((c) => c.ready)) return 'Ready';
    return p.status.phase;
  };
  return {
    available: true,
    mode, modes: K8S_MODES, scalable: scale, runtime,
    nodes: JSON.parse(nodes.out).items.map((n) => ({
      name: n.metadata.name,
      role: n.metadata.labels['node-role.kubernetes.io/control-plane'] !== undefined ? '控制節點' : '工作節點',
      ready: n.status.conditions.find((c) => c.type === 'Ready')?.status === 'True',
      ...usage[n.metadata.name],
    })),
    // 跑完的 Job（灌資料、壓測結束的 k6）不畫
    pods: pods.code === 0 ? JSON.parse(pods.out).items.filter((p) => p.status.phase !== 'Succeeded').map((p) => ({
      name: p.metadata.name, node: p.spec.nodeName ?? null, service: p.metadata.labels?.['demo/service'] ?? p.metadata.labels?.app ?? '?', status: podStatus(p),
    })) : [],
    autoscalers: hpa.code === 0 ? JSON.parse(hpa.out).items.map((h) => {
      const m = h.status.currentMetrics?.[0];
      const t = h.spec.metrics?.[0];
      return {
        name: h.spec.scaleTargetRef.name, kind: h.metadata.name.startsWith('keda-') ? 'KEDA（佇列長度）' : 'HPA（CPU）',
        current: h.status.currentReplicas ?? 0, desired: h.status.desiredReplicas ?? 0, min: h.spec.minReplicas, max: h.spec.maxReplicas,
        metric: m?.resource ? `CPU ${m.resource.current.averageUtilization ?? '?'}%（目標 ${t.resource.target.averageUtilization}%）`
          : m?.external ? `每個 Pod ${/mysql/.test(m.external.metric?.name ?? '') ? 'outbox 待送' : '排隊'} ${qty(m.external.current.averageValue ?? m.external.current.value)}（目標 ${qty(t.external.target.averageValue)}）` : '-',
      };
    }) : [],
  };
}

const json = (res, body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((done) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { done(JSON.parse(b || '{}')); } catch { done({}); } }); });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(import.meta.dirname, 'ui.html'))); }
    if (p === '/api/cluster') return json(res, await cluster());
    if (p === '/api/state') return json(res, { loadtestRunning: jobs.some((j) => j.status === 'running' && j.kind === 'loadtest'), k8sBusy: jobs.some((j) => j.status === 'running' && j.kind === 'k8s'), tests: testsList(), sets: await runningSets(), scenarios: allScenarios(['test', 'load', 'soak']).map(({ name, title, description, kind }) => ({ name, title, description, kind })), jobs: jobs.slice(0, 20).map(({ lines, ...j }) => ({ ...j, tail: lines.slice(-12) })), runs: runsList() });
    if (req.method === 'POST' && p === '/api/sets/up') {
      const { n } = await readBody(req);
      return json(res, startJob(`啟動第 ${n} 套`, ['scripts/sandbox.sh', 'up', String(Number(n))]));
    }
    if (req.method === 'POST' && p === '/api/sets/down') {
      const { n } = await readBody(req);
      return json(res, startJob(`刪除第 ${n} 套`, ['scripts/sandbox.sh', 'down', String(Number(n))]));
    }
    // K8s 的 Pod 數模式：切換後一直維持（loadtest/k8s-mode.mjs）
    // 壓測中可以切模式（跑完會保留手動切的）；另一個切換、重新部署還沒做完時不能切。重新部署在壓測中也不行（會重建所有服務）
    const running = (...kinds) => jobs.find((j) => j.status === 'running' && kinds.includes(j.kind));
    const blocker = p === '/api/k8s/redeploy' || p === '/api/k8s/runtime' ? running('k8s', 'loadtest') : running('k8s');
    if (req.method === 'POST' && (p === '/api/k8s/mode' || p === '/api/k8s/redeploy' || p === '/api/k8s/runtime') && blocker) {
      return json(res, { error: `#${blocker.id}「${blocker.label}」還在進行，等它結束再操作` }, 409);
    }
    // 個別服務手動調 Pod 數（幾個 kubectl 指令，馬上回來；Pod 增減由 K8s 自己做）。壓測中也可以
    if (req.method === 'POST' && p === '/api/k8s/scale') {
      const { service, replicas } = await readBody(req);
      await setReplicas(String(service), Number(replicas));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/k8s/mode') {
      const { mode } = await readBody(req);
      if (!K8S_MODES[mode]) return json(res, { error: `不認識的模式：${mode}` }, 400);
      return json(res, Object.assign(startJob(`K8s 模式 → ${K8S_MODES[mode]}`, ['node', 'loadtest/k8s-mode.mjs', mode]), { kind: 'k8s' }));
    }
    // core-api 的 PHP 執行方式（fpm／octane）：寫進 .env 的 CORE_RUNTIME 再重新部署（scripts/k8s.sh runtime）。壓測中不行（會換掉所有 core-api Pod）
    if (req.method === 'POST' && p === '/api/k8s/runtime') {
      const { runtime } = await readBody(req);
      const label = { fpm: 'PHP-FPM', octane: 'Octane（Swoole）', go: 'Go' }[runtime];
      if (!label) return json(res, { error: `只能是 fpm、octane 或 go：${runtime}` }, 400);
      return json(res, Object.assign(startJob(`core-api 執行方式 → ${label}（重新部署）`, ['scripts/k8s.sh', 'runtime', runtime]), { kind: 'k8s' }));
    }
    // 重新部署 K8s：重新 build image、terraform apply（scripts/bootstrap.sh；也會重新啟動 sandbox 第 1 套）
    if (req.method === 'POST' && p === '/api/k8s/redeploy') return json(res, Object.assign(startJob('重新部署 K8s（scripts/bootstrap.sh）', ['scripts/bootstrap.sh']), { kind: 'k8s' }));
    // 壓測（微服務處理速度）：跑在 sandbox 第 1 套或 K8s（指定模式）；完美世界、只買直送、不打查詢
    if (req.method === 'POST' && p === '/api/loadtest') {
      const b = await readBody(req);
      // 一次只跑一輪：兩輪同時跑，數字互相干擾（第二輪也會卡在等同一套的鎖）
      const busy = jobs.find((j) => j.status === 'running' && (j.kind === 'loadtest' || j.kind === 'k8s'));
      if (busy) return json(res, { error: `#${busy.id}「${busy.label}」還在進行，等它結束再開壓測` }, 409);
      const mode = b.target === 'k8s' ? String(b.mode) : 'dev-container';
      if (mode !== 'dev-container' && !K8S_MODES[mode]) return json(res, { error: `不認識的模式：${mode}` }, 400);
      const num = (v, d) => String(v ?? d).replace(/[^\d,]/g, '') || String(d);
      // 說明可以不填：設定（模式、世界、桶數…）已經自動寫進資料夾名稱和報告，說明只寫「這一輪改了什麼」
      const change = String(b.change ?? '').replace(/["\\\n]/g, ' ').trim().slice(0, 80);
      // 世界：perfect（廠商延遲全部 0，量我們自己的服務）、realistic（廠商有延遲、少量錯誤），或兩個都跑（各重建一次環境）
      const worlds = ['perfect', 'realistic', 'perfect,realistic'].includes(b.worlds) ? b.worlds : 'perfect';
      const args = ['node', 'loadtest/run.mjs', '--mode', mode, '--worlds', worlds, '--direct-only', '--ratio', '0',
        '--levels', num(b.levels, '5,10,20'), '--hold', num(b.hold, 60), '--idle', num(b.idle, 0), '--max-vus', num(b.maxVus, 2000),
        '--buckets', String(Math.max(1, Math.min(64, Number(b.buckets) || 1))), '--logistics-callbacks', b.logisticsCallbacks === false ? 'off' : 'on', ...(change ? ['--change', change] : [])];
      // 工作名稱從實際送出的參數產生（和報告資料夾同一套規則，loadtest/naming.mjs）；執行方式讀叢集現在部署的
      const runtime = await (mode === 'dev-container' ? sandboxRuntime() : k8sRuntime()).catch(() => null);
      const label = configLabel({ modeLabel: mode === 'dev-container' ? 'dev-container 第 1 套' : `K8s ${K8S_MODES[mode]}`, worlds, buckets: args[args.indexOf('--buckets') + 1],
        logisticsCallbacks: args[args.indexOf('--logistics-callbacks') + 1] === 'on', runtime, levels: args[args.indexOf('--levels') + 1] });
      return json(res, Object.assign(startJob(`壓測｜${label}`, args), { kind: 'loadtest' }));
    }
    // Datadog 逐服務開關：存下選擇並套用（scripts/sandbox.sh datadog N …；和其他操作一樣會排隊）
    if (req.method === 'POST' && p === '/api/sets/datadog') {
      const { n, services, apm } = await readBody(req);
      const sel = Array.isArray(services) && services.length ? services.map((x) => String(x).replace(/[^a-z-]/g, '')).join(',') : 'off';
      // apm=false：只送指標和 log、不開 APM trace（壓測用：trace 很吃 CPU）
      return json(res, startJob(`第 ${n} 套 Datadog：${sel}（APM ${apm === false ? '關' : '開'}）`, ['scripts/sandbox.sh', 'datadog', String(Number(n)), sel, ...(apm === false ? ['--no-apm'] : [])]));
    }
    // 庫存分桶（熱賣模式）：第 N 套（target＝桶數，skus 空白＝所有商品），或 K8s（n 不給）；跑到一半也可以改
    if (req.method === 'POST' && p === '/api/buckets') {
      const { n, target, skus } = await readBody(req);
      const t = String(Math.max(1, Math.min(64, Number(target) || 1)));
      const list = String(skus ?? '').split(/[\s,]+/).map((x) => x.replace(/[^A-Z0-9-]/gi, '')).filter(Boolean);
      const where = n ? `第 ${n} 套` : 'K8s';
      const args = n ? ['scripts/sandbox.sh', 'buckets', String(Number(n)), t, ...list] : ['scripts/k8s.sh', 'buckets', t, ...list];
      return json(res, startJob(`${where} 庫存分 ${t} 桶${list.length ? `（${list.join('、')}）` : ''}`, args));
    }
    if (req.method === 'POST' && p === '/api/run') {
      const b = await readBody(req);
      const args = ['node', 'sandbox/cli.mjs', 'run', ...(b.scenarios ?? []).map(String)];
      const safe = (v) => String(v).replace(/[^\w.,:-]/g, '');   // 只接受簡單的值，不讓 UI 塞奇怪的參數
      if (b.sets) args.push('--sets', safe(b.sets));
      if (b.seed) args.push('--seed', safe(b.seed));
      if (b.only) args.push('--only', safe(b.only));
      if (b.repeat) args.push('--repeat', safe(b.repeat));
      for (const k of ['rps', 'hold', 'duration']) if (b[k]) args.push(`--${k}`, safe(b[k]));
      if (b.noBuild) args.push('--no-build');
      if (b.force) args.push('--force');
      return json(res, startJob(`跑 ${(b.scenarios ?? []).join('、') || '全部情境'}`, args));
    }
    // 壓測報告：只允許 repo 旁邊的 ../tests 底下
    if (p.startsWith('/tests/')) {
      const file = normalize(join(TESTS, decodeURIComponent(p.slice(7))));
      if (!file.startsWith(TESTS) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' });
      return res.end(readFileSync(file));
    }
    // 報告、log 檔：只允許 sandbox-runs 底下
    if (p.startsWith('/runs/')) {
      const file = normalize(join(RUNS, decodeURIComponent(p.slice(6))));
      if (!file.startsWith(RUNS) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(readFileSync(file));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, { error: String(e) }, 500);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`sandbox UI：http://localhost:${PORT}`));
