// 範例資料（假的）：只用來確認報告格式，故事照 M20（1 桶 vs 8 桶）編
// node loadtest/report/cli.mjs --sample 會用這裡的兩份產生範例報告

const PERFECT = {
  payment: { latencyMs: 0, latencyJitterMs: 0, errorRate: 0, callbackDelayMs: 500 },
  logistics: { latencyMs: 0, latencyJitterMs: 0, errorRate: 0 },
  clinic: { latencyMs: 0, latencyJitterMs: 0, errorRate: 0 },
};
const REALISTIC = {
  payment: { latencyMs: 150, latencyJitterMs: 1200, errorRate: 0.005, callbackDelayMs: 800 },
  logistics: { latencyMs: 100, latencyJitterMs: 400, errorRate: 0.005 },
  clinic: { latencyMs: 200, latencyJitterMs: 600, errorRate: 0.005 },
};

const ORDER = [20, 40, 60, 80, 100];
const QUERY_RATIO = 20;   // 查詢＝下單 × 20，兩條流量同時打
const QUERY = ORDER.map((x) => x * QUERY_RATIO);
const RAMP = 15;
const HOLD = 40;
const d = (p50, p95, p99, n) => ({ n, p50, p95, p99 });
const INVARIANTS = ['庫存不超賣（每一桶 reserved ≥ 0、on_hand ≥ reserved）', '訂單金額 = 明細加總', '每筆付款都有對應訂單', '每筆訂單最後都有結局（PAID／FAILED）', '寄倉數量對得起來', '退款不超過付款'];

// 每一階的服務負載：pods、每個 Pod 平均 CPU（m）
function services(i, { buckets, lockBound }) {
  const coreApiPods = [2, 6, 8, 8, 8][i];
  const coreApiCpu = lockBound ? [180, 320, 420, 450, 460][i] : [190, 410, 620, 790, 830][i];
  return {
    'core-api': { pods: coreApiPods, maxPods: 8, cpuM: coreApiCpu, cpuCapM: null, memMi: 210, memLimitMi: 512 },
    'core-worker': { pods: [2, 4, 8, 8, 8][i], maxPods: 8, cpuM: lockBound ? [20, 15, 10, 8, 6][i] : [40, 60, 80, 88, 90][i], cpuCapM: 1000, memMi: 120, memLimitMi: 256 },
    'hub-payment': { pods: [1, 2, 3, 4, 5][i], maxPods: 6, cpuM: 60, cpuCapM: 1000, memMi: 90, memLimitMi: 256 },
    'hub-logistics': { pods: [1, 2, 2, 3, 4][i], maxPods: 6, cpuM: 40, cpuCapM: 1000, memMi: 85, memLimitMi: 256 },
    bff: { pods: 1, maxPods: 5, cpuM: 5, cpuCapM: 1000, memMi: 70, memLimitMi: 256 },
    mysql: { pods: 1, maxPods: 1, cpuM: lockBound ? [300, 500, 600, 620, 640][i] : [350, 700, 1100, 1400, 1600][i], cpuCapM: null, memMi: 900, memLimitMi: 2048 },
    localstack: { pods: 1, maxPods: 1, cpuM: [200, 400, 600, 750, 800][i], cpuCapM: 1000, memMi: 400, memLimitMi: 1024 },
  };
}

function world(settings, { buckets, realistic }) {
  const lockBound = buckets === 1;
  const e2eBase = realistic ? d(1250, 2250, 2400) : d(640, 730, 760);
  const jitter = realistic ? 1.12 : 1;
  const levels = ORDER.map((order, i) => {
    // 1 桶：60 開始等鎖、80 撐不住；8 桶：100 才因 CPU 變慢
    const slow = lockBound ? [1, 1.3, 4, 30, 28][i] : [1, 1.4, 1.5, 1.6, 6][i];
    const achievedOrder = lockBound ? [20, 40, 60, 58, 61][i] : [20, 40, 59, 79, 73][i];
    const fpmMax = 10 * services(i, { buckets, lockBound })['core-api'].pods;
    return {
      target: { query: QUERY[i], order },
      achieved: { query: QUERY[i] - (slow > 10 ? 240 : 0), order: realistic && i === ORDER.length - 1 ? achievedOrder - 4 : achievedOrder },
      dropped: lockBound ? [0, 0, 0, 1800, 1300][i] : [0, 0, 0, 0, 1350][i],
      success: { query: 1, order: slow > 10 ? 0.982 : 0.9995 },
      // 真實世界的查詢、結帳 API 理論上一樣，實際會因為背景處理比較忙稍慢一點
      query: d(Math.round(9 * Math.min(slow, 3) * jitter), Math.round(38 * Math.min(slow, 4) * jitter), Math.round(75 * Math.min(slow, 5) * jitter), QUERY[i] * HOLD),
      pay_api: d(Math.round(25 * slow * jitter), Math.round(52 * slow * jitter), Math.round(90 * slow * jitter), achievedOrder * 40 * 0.85),
      pay_e2e: d(Math.round(e2eBase.p50 * (1 + (slow - 1) * 0.6)), Math.round(e2eBase.p95 * (1 + (slow - 1) * 0.8)), Math.round(e2eBase.p99 * (1 + (slow - 1))), Math.round(achievedOrder * 40 * 0.85)),
      steps: steps(slow * jitter, lockBound),
      e2eUnfinished: slow > 10 ? 420 : 0,
      sat: {
        services: services(i, { buckets, lockBound }),
        fpm: { busy: lockBound ? Math.min(fpmMax, [6, 30, 75, 80, 80][i]) : Math.min(fpmMax, [5, 20, 40, 62, 80][i]), max: fpmMax, queue: lockBound ? [0, 0, 4, 120, 140][i] : [0, 0, 0, 0, 90][i] },
        db: { conns: [12, 30, 70, 85, 88][i], maxConns: 151, lockWaits: lockBound ? [0, 4, 22, 58, 64][i] : [0, 0, 2, 6, 10][i] },
        sqs: {
          'payment-commands': { backlog: realistic ? [5, 20, 60, 140, 180][i] : [2, 5, 8, 10, 30][i], growthPerSec: realistic ? [0, 0.1, 0.5, 2, 3][i] : [0, 0, 0, 0, 0.5][i] },
          'core-commands': { backlog: [3, 6, 10, 15, 20][i], growthPerSec: 0 },
          'integration-events': { backlog: lockBound ? [10, 200, 5000, 30000, 52000][i] : [5, 10, 30, 80, 400][i], growthPerSec: lockBound ? [0, 0.5, 120, 600, 500][i] : [0, 0, 0.2, 0.8, 8][i] },
        },
        host: { cpuUsed: lockBound ? [2.1, 4.5, 6.8, 7.5, 7.5][i] : [2.3, 5.2, 7.4, 8.6, 9.3][i], cpus: 10 },
      },
    };
  });
  return {
    partnerSettings: settings,
    idle: { query: d(9, 36, 70, 3600), pay_api: d(22, 48, 85, 153), pay_e2e: { ...e2eBase, n: 151 }, steps: steps(1, false) },
    levels,
    timeseries: timeseries(levels),
    correctness: { invariants: INVARIANTS.map((name) => ({ name, pass: true })) },
  };
}

/** 每一種請求：等鎖時結帳、放商品慢得最多（都要碰庫存那一列），查詢、看購物車只是排隊 */
function steps(slow, lockBound) {
  const f = (base, k) => d(Math.round(base * k), Math.round(base * 2.2 * k), Math.round(base * 4 * k), 1000);
  const hot = lockBound ? slow : Math.sqrt(slow);
  return { catalog: f(9, Math.min(slow, 3)), login: f(60, Math.sqrt(slow)), cart: f(12, Math.sqrt(slow)), 'cart-clear': f(15, Math.sqrt(slow)), put: f(20, hot), 'put-booking': f(35, Math.sqrt(slow)), checkout: f(25, hot) };
}

/** 每 5 秒一筆：各服務的 Pod 數、每個 Pod 的 CPU。Pod 擴充比流量慢半拍（HPA 要時間） */
function timeseries(levels) {
  const out = [];
  const step = RAMP + HOLD;
  for (let t = 0; t <= step * levels.length; t += 5) {
    const i = Math.min(levels.length - 1, Math.floor(t / step));
    const into = t - i * step;
    const prev = levels[i - 1]?.sat.services ?? levels[0].sat.services;
    const cur = levels[i].sat.services;
    const k = Math.min(1, into / 35);   // 進到新的一階後約 35 秒才擴完
    const services = {};
    for (const [name, s] of Object.entries(cur)) {
      const p = prev[name];
      services[name] = { pods: Math.round(p.pods + (s.pods - p.pods) * k), cpuM: Math.round(p.cpuM + (s.cpuM - p.cpuM) * Math.min(1, into / 15)), cpuCapM: s.cpuCapM };
    }
    out.push({ t, services });
  }
  return out;
}

export function sampleRun({ buckets }) {
  return {
    schema: 1,
    sample: true,
    meta: {
      id: `20261014-1530-buckets${buckets}`,
      startedAt: '2026-10-14 15:30',
      commit: buckets === 1 ? '91c5294' : '3d97ddb',
      seed: 42,
      mode: 'k8s-auto',
      change: buckets === 1 ? null : '庫存 1 桶 → 8 桶',
      catalog: '搶購：11 個商品（9 直送＋寄倉飼料＋健檢）',
      buckets,
      dbReset: true,
      idle: { order: 1, query: QUERY_RATIO, holdSec: 180 },
      queryRatio: QUERY_RATIO,
      levels: { query: QUERY, order: ORDER },
      rampSec: RAMP,
      holdSec: HOLD,
      env: { 節點: '1 控制＋3 工作（kind on OrbStack）', 電腦: 'Mac mini 10 核' },
    },
    worlds: {
      perfect: world(PERFECT, { buckets, realistic: false }),
      realistic: world(REALISTIC, { buckets, realistic: true }),
    },
  };
}
