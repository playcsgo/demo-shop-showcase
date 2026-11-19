// 把原始資料整理成 run.json 的格式：取樣 → 每一階的最大值、時間序列；Loki 的 log → pay_e2e
//
// 時間窗口（epoch ms）：低流量＝整段；每一階＝維持那段（爬升不算），跟 k6 的 lvl 標籤一致

/** k6 的結果＋開始時間 → 每一階的時間窗口 */
export function windows(t0, k6) {
  const out = [];
  if (k6.idle) out.push({ lvl: 'idle', from: t0, to: t0 + k6.idle * 1000 });
  k6.levelStarts.forEach((s, i) => out.push({ lvl: String(i), from: t0 + (s + k6.ramp) * 1000, to: t0 + (s + k6.ramp + k6.hold) * 1000 }));
  return out;
}

const pick = (arr, f) => arr.map(f).filter((v) => v != null && !Number.isNaN(v));
const max = (arr) => (arr.length ? Math.max(...arr) : null);

/** 一個窗口裡的取樣 → sat（每項取最大值；SQS 另外算維持那段積壓每秒變多少） */
export function saturationIn(samples, { from, to }) {
  const xs = samples.filter((s) => s.t >= from && s.t <= to);
  if (!xs.length) return null;
  const names = [...new Set(xs.flatMap((s) => Object.keys(s.services)))];
  const services = {};
  for (const n of names) {
    const ss = xs.map((s) => s.services[n]).filter(Boolean);
    const last = ss.at(-1);
    services[n] = {
      pods: max(pick(ss, (s) => s.pods)), maxPods: last.maxPods,
      cpuM: max(pick(ss, (s) => s.cpuM)), cpuCapM: last.cpuCapM,
      memMi: max(pick(ss, (s) => s.memMi)), memLimitMi: last.memLimitMi,
    };
  }
  const fpm = xs.map((s) => s.fpm).filter(Boolean);
  const db = xs.map((s) => s.db).filter(Boolean);
  const sq = xs.filter((s) => s.sqs);
  const sqs = {};
  if (sq.length) {
    for (const q of Object.keys(sq[0].sqs)) {
      const first = sq[0], last = sq.at(-1);
      const secs = (last.t - first.t) / 1000;
      sqs[q] = { backlog: max(sq.map((s) => s.sqs[q] ?? 0)), growthPerSec: secs > 0 ? Math.round(((last.sqs[q] - first.sqs[q]) / secs) * 10) / 10 : 0 };
    }
  }
  return {
    services,
    // 忙碌數和上限要取同一個時間點（Pod 數會變：只有 2 個 Pod 時忙 20／20，擴到 8 個後上限變 80，分開取最大值會變成 20／80）
    fpm: fpm.length ? (({ busy, max: cap }) => ({ busy, max: cap, queue: max(fpm.map((f) => f.queue)) }))(fpm.reduce((a, f) => (f.busy / f.max > a.busy / a.max ? f : a))) : null,
    db: db.length ? { conns: max(db.map((d) => d.conns)), maxConns: db.at(-1).maxConns, lockWaits: max(db.map((d) => d.lockWaits)) } : null,
    sqs: sq.length ? sqs : null,
    host: { cpuUsed: max(xs.map((s) => s.host.cpuUsed)), cpus: xs.at(-1).host.cpus },
    samples: xs.length,
  };
}

/** 時間序列（畫 Pod 數與 CPU）：t＝從第一階開始算的秒數 */
export function timeseries(samples, levelsFrom) {
  return samples.filter((s) => s.t >= levelsFrom).map((s) => ({
    t: Math.round((s.t - levelsFrom) / 1000),
    services: Object.fromEntries(Object.entries(s.services).map(([n, x]) => [n, { pods: x.pods, cpuM: x.cpuM, cpuCapM: x.cpuCapM }])),
  }));
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
export const dist = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99) };
};

// ───────── Loki：pay_e2e ─────────
/** 撈 LogQL 查詢在時間範圍內的所有 log 行（分頁，每頁 5000） */
export async function lokiLines(url, query, from, to) {
  const out = [];
  let start = BigInt(from) * 1_000_000n;
  const end = BigInt(to) * 1_000_000n;
  for (;;) {
    const u = new URL(`${url}/loki/api/v1/query_range`);
    u.search = new URLSearchParams({ query, start: String(start), end: String(end), limit: '5000', direction: 'forward' }).toString();
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Loki 查詢失敗 ${r.status}：${(await r.text()).slice(0, 300)}`);
    const values = (await r.json()).data.result.flatMap((s) => s.values).sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
    for (const [, line] of values) {
      try { out.push(JSON.parse(line)); } catch { /* 不是 JSON 的行略過 */ }
    }
    if (values.length < 5000) return out;
    start = BigInt(values.at(-1)[0]) + 1n;
  }
}

/**
 * 下單 → 付款完成：用 order_no 配對 core-api 的 `order placed` 和 core-worker 的 `payment succeeded → order PAID`
 * 只算直送／寄倉（capture_mode=auto）：預約是授權後等醫院確認才請款，不會有 PAID 那行
 * 回傳每個窗口的 { pay_e2e, e2eUnfinished, e2eFailed }，以及 Loki 一共收到幾筆下單（對照資料庫，看 log 有沒有掉）
 */
export async function payE2e(url, wins, until) {
  const from = Math.min(...wins.map((w) => w.from)) - 60_000;
  const [placed, paid, failed] = await Promise.all([
    lokiLines(url, '{service="core-api"} |= "order placed"', from, until),
    lokiLines(url, '{service="core-worker"} |= "payment succeeded"', from, until),
    lokiLines(url, '{service="core-worker"} |= "payment failed"', from, until),
  ]);
  const paidAt = new Map(paid.map((l) => [l.order_no, Date.parse(l.ts)]));
  const failedSet = new Set(failed.map((l) => l.order_no));
  const perWindow = {};
  for (const w of wins) {
    const mine = placed.filter((l) => l.capture_mode === 'auto' && Date.parse(l.ts) >= w.from && Date.parse(l.ts) <= w.to);
    const ms = [];
    let unfinished = 0, fails = 0;
    for (const l of mine) {
      const p = paidAt.get(l.order_no);
      if (p != null) ms.push(p - Date.parse(l.ts));
      else if (failedSet.has(l.order_no)) fails++;
      else unfinished++;
    }
    perWindow[w.lvl] = { pay_e2e: dist(ms), e2eUnfinished: unfinished, e2eFailed: fails };
  }
  return { perWindow, placedInLoki: placed.length };
}
