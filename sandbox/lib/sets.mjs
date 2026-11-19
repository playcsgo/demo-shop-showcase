// 測試的套數：用 scripts/sandbox.sh 開關，這裡負責「在第 N 套裡做事」
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');

// 所有佇列（和 infra/localstack/init-aws.sh、core config/messaging.php 一致）：指令依廠商分佇列
export const COMMAND_QUEUES = ['core-commands', 'payment-commands', 'payment-reconcile-commands', 'logistics-commands', 'clinic-commands', 'line-commands'];
export const QUEUES = [...COMMAND_QUEUES, 'integration-events', 'analytics-events'];

/** 執行指令，回傳 { code, out }；不丟例外，由呼叫端判斷 */
export function sh(cmd, args, { env = {}, input, timeoutMs = 600_000, cwd = ROOT } = {}) {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); done({ code: code ?? 1, out }); });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 第 N 套：port 規則和 scripts/sandbox.sh 一樣（2＋服務碼＋0＋兩位數套數） */
export class SandboxSet {
  constructor(n, tag, datadog = null) {
    this.datadog = datadog;   // 這次 run 指定的 Datadog 服務（--datadog）；null＝沿用這一套存下來的選擇
    this.n = n;
    this.nn = String(n).padStart(2, '0');
    this.project = `demo-sb${this.nn}`;
    this.tag = tag;
    this.ports = {
      core: `210${this.nn}`, bff: `220${this.nn}`, hub: `230${this.nn}`, partners: `240${this.nn}`,
      mysql: `260${this.nn}`, redis: `270${this.nn}`, grafana: `280${this.nn}`,
    };
    this.timeScale = null;   // 目前 core 用的時間壓縮倍數（換倍數要重建 core）
  }

  get partnersUrl() { return `http://localhost:${this.ports.partners}`; }
  get grafanaUrl() { return `http://localhost:${this.ports.grafana}`; }
  get network() { return `${this.project}_default`; }

  /** 目前送 Datadog 的服務（空陣列＝沒開） */
  datadogServices() {
    const all = 'core-api,core-relay,core-worker,core-scheduler,core-nginx,bff-gateway,hub,partners,mysql,redis';
    let sel = this.datadog ?? (() => { try { return readFileSync(join(ROOT, '.sandbox/datadog', this.project), 'utf8').trim(); } catch { return ''; } })();
    if (sel === 'all') sel = all;
    if (sel === 'off') sel = '';
    return sel ? sel.split(',') : [];
  }

  env(extra = {}) {
    const keyFile = join(ROOT, '.sandbox/keys', this.project);
    return {
      SANDBOX_TAG: this.tag,
      SANDBOX_LOCK_HELD: this.project,   // 這一套的鎖由我們（cli）持有，scripts/sandbox.sh 不用再搶
      ...(this.datadog ? { SANDBOX_DATADOG: this.datadog } : {}),
      ...(existsSync(keyFile) ? { SANDBOX_APP_KEY: readFileSync(keyFile, 'utf8').trim() } : {}),
      ...extra,
    };
  }

  /**
   * 跑情境的整段時間都持有這一套的鎖（和 scripts/sandbox.sh 用同一個資料夾）：
   * 同時從 UI 按「啟動」或另開一個 run，會排隊等，不會兩邊同時重建容器而撞名
   */
  async lock(what, log) {
    const dir = join(ROOT, '.sandbox/locks', this.project);
    mkdirSync(join(ROOT, '.sandbox/locks'), { recursive: true });
    for (let waited = 0; ; waited++) {
      try {
        mkdirSync(dir);
        writeFileSync(join(dir, 'pid'), String(process.pid));
        writeFileSync(join(dir, 'what'), what);
        const release = () => { try { if (readFileSync(join(dir, 'pid'), 'utf8') === String(process.pid)) rmSync(dir, { recursive: true, force: true }); } catch { /* 已經不在了 */ } };
        process.on('exit', release);
        return release;
      } catch {
        const owner = Number((() => { try { return readFileSync(join(dir, 'pid'), 'utf8'); } catch { return 0; } })());
        let alive = false;
        try { if (owner) { process.kill(owner, 0); alive = true; } } catch { alive = false; }
        if (!alive) { rmSync(dir, { recursive: true, force: true }); continue; }
        if (waited === 0) log?.(`${this.project} 正在被其他操作使用（${(() => { try { return readFileSync(join(dir, 'what'), 'utf8'); } catch { return '?'; } })()}），等它結束…`);
        await sleep(1000);
      }
    }
  }

  /** 啟動（已經在跑就只套用新的設定）；timeScale 改變時 core 會重建 */
  async up(timeScale = 1) {
    const r = await sh('scripts/sandbox.sh', ['up', String(this.n), '--no-build'], { env: this.env({ TIME_SCALE: String(timeScale) }) });
    if (r.code !== 0) throw new Error(`第 ${this.n} 套啟動失敗：\n${r.out.slice(-2000)}`);
    this.timeScale = timeScale;
  }

  async down() {
    await sh('scripts/sandbox.sh', ['down', String(this.n)], { env: this.env() });
  }

  compose(args, opts = {}) {
    return sh('docker', ['compose', '-p', this.project, '-f', 'compose.sandbox.yaml', ...args], { ...opts, env: { ...this.env({ TIME_SCALE: String(this.timeScale ?? 1) }), ...(opts.env ?? {}) } });
  }

  /** 在這一套的 core 執行 artisan */
  artisan(...args) {
    return this.compose(['exec', '-T', 'core-api', 'php', 'artisan', ...args]);
  }

  async artisanJson(...args) {
    const r = await this.artisan(...args);
    const line = r.out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    if (!line) throw new Error(`artisan ${args.join(' ')} 沒有回傳 JSON：\n${r.out.slice(-1000)}`);
    return { code: r.code, data: JSON.parse(line) };
  }

  /** 在這一套的 MySQL 查一個值（只用在判定結果、找證據） */
  async sql(query) {
    const r = await this.compose(['exec', '-T', 'mysql', 'mysql', '-udemo', '-pdemo', 'demo', '-N', '-B', '-e', query]);
    return r.out.split('\n').filter((l) => l && !l.includes('Using a password')).map((l) => l.split('\t'));
  }

  async partners(method, path, body) {
    const res = await fetch(`${this.partnersUrl}${path}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`partners ${method} ${path} → ${res.status}`);
    return res.json();
  }

  /**
   * 回到乾淨狀態（每個情境開始前，約 10 秒）：
   *   停掉會動資料的程序 → 清 SQS、Redis → 資料庫重建＋種子資料 → 依情境調整資料 → partners 清空 → 程序重新啟動
   */
  async reset(data, timeScale = 1) {
    const workers = ['core-relay', 'core-worker', 'core-scheduler', 'hub'];
    await this.compose(['stop', ...workers]);
    for (const q of QUEUES) {
      for (const name of [q, `${q}-dlq`]) {
        await this.compose(['exec', '-T', 'localstack', 'awslocal', 'sqs', 'purge-queue', '--queue-url', `http://localhost:4566/000000000000/${name}`]);
      }
    }
    // SQS 可見性逾時跟著時間壓縮（30 秒 ÷ 倍數，最少 1 秒；整數秒）
    const visibility = String(Math.max(1, Math.round(30 / timeScale)));
    for (const q of QUEUES) {
      await this.compose(['exec', '-T', 'localstack', 'awslocal', 'sqs', 'set-queue-attributes', '--queue-url', `http://localhost:4566/000000000000/${q}`, '--attributes', `VisibilityTimeout=${visibility}`]);
    }
    await this.compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']);
    const fresh = await this.artisan('migrate:fresh', '--seed', '--force');
    if (fresh.code !== 0) throw new Error(`資料庫重建失敗：\n${fresh.out.slice(-1500)}`);
    const args = ['sandbox:data', `--customers=${data.CUSTOMERS ?? 30}`, `--stock=${data.STOCK ?? 1000000}`];
    for (const [k, v] of Object.entries(data)) if (k.startsWith('STOCK.')) args.push(`--sku=${k.slice(6)}:${v}`);
    // 庫存分桶（熱賣模式）：BUCKETS＝所有商品、BUCKETS.<SKU>＝個別；跑到一半要改用 UI 或 scripts/sandbox.sh buckets
    if (data.BUCKETS) args.push(`--buckets=${data.BUCKETS}`);
    for (const [k, v] of Object.entries(data)) if (k.startsWith('BUCKETS.')) args.push(`--bucket=${k.slice(8)}:${v}`);
    const seeded = await this.artisan(...args);
    if (seeded.code !== 0) throw new Error(`測試資料設定失敗：\n${seeded.out.slice(-1500)}`);
    await this.partners('POST', '/admin/reset');
    await this.compose(['start', ...workers]);
    // 等 hub 回來（它要重新連 SQS）
    for (let i = 0; i < 60; i++) {
      const ok = await fetch(`http://localhost:${this.ports.hub}/health`).then((r) => r.ok).catch(() => false);
      if (ok) return;
      await sleep(1000);
    }
    throw new Error('hub 沒有回來');
  }

  /**
   * log 管線的狀態：Loki 收到哪些服務、Alloy 讀到／送出／丟掉幾行
   * Alloy 的 port 沒有對外開，從同一個網路裡的 Grafana 容器去讀它的 metrics
   */
  async logPipeline() {
    const r = await fetch(`${this.grafanaUrl}/api/datasources/proxy/uid/loki/loki/api/v1/label/service/values`).catch((e) => ({ ok: false, status: e.message, text: async () => '' }));
    const services = r.ok ? ((await r.json()).data ?? []) : [];
    const lokiError = r.ok ? null : `${r.status} ${(await r.text()).slice(0, 200)}`;
    const m = (await this.compose(['exec', '-T', 'grafana', 'wget', '-qO-', 'http://alloy:12345/metrics'])).out;
    const sum = (name) => m.split('\n').filter((l) => l.startsWith(`${name}{`)).reduce((n, l) => n + Number(l.split(' ').pop()), 0);
    return {
      services, lokiError,
      alloy: { read: sum('loki_source_docker_target_entries_total'), sent: sum('loki_write_sent_entries_total'), dropped: sum('loki_write_dropped_entries_total') },
    };
  }

  /** 查這一套的 Loki（經過這一套的 Grafana） */
  async loki(query, { startNs, endNs = Date.now() * 1e6, limit = 5000 } = {}) {
    const u = new URL(`${this.grafanaUrl}/api/datasources/proxy/uid/loki/loki/api/v1/query_range`);
    u.searchParams.set('query', query);
    u.searchParams.set('start', String(BigInt(Math.floor(startNs))));
    u.searchParams.set('end', String(BigInt(Math.floor(endNs))));
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('direction', 'forward');
    const res = await fetch(u);
    // 查不到要讓呼叫端知道：回傳空陣列會被當成「沒有 log」，分不出是 Loki 沒收到還是查詢壞了
    if (!res.ok) throw new Error(`Loki 查詢失敗：${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const lines = [];
    for (const stream of body.data?.result ?? []) {
      for (const [ts, line] of stream.values) lines.push({ ts: Number(BigInt(ts) / 1000000n), service: stream.stream.service, line });
    }
    return lines.sort((a, b) => a.ts - b.ts);
  }
}
