// 壓測報告用（node loadtest/run.mjs）：先跑低流量基準，再一階一階加壓
//   查詢和下單兩條流量同時打，查詢＝下單 × QUERY_RATIO
//   每一階是獨立的 scenario：才算得出「這一階有幾個客人進不來」（dropped_iterations 只能按 scenario 分）
//   只統計每一階「維持」那段（爬升那段不打 lvl 標籤）
//
// 環境變數：ORDER_LEVELS=20,40,60  QUERY_RATIO=20  RAMP=15  HOLD=40  IDLE=180  IDLE_ORDER=1  MAX_VUS=2000  DIRECT_ONLY=1
//   QUERY_RATIO=0：只下單、不打查詢｜DIRECT_ONLY=1：只買直送商品（量訂單流程本身：沒有寄倉、預約的分支）
// 輸出：K6_T0 <開始的 epoch ms>（scenario 的時間從這裡算）、K6_RESULT <JSON>（loadtest/collect 讀）
//
// 每個虛擬客人用自己的帳號（shopperN，N＝__VU）：帳號數要 ≥ 所有 scenario 的 maxVUs 加總，見 customersNeeded
import exec from 'k6/execution';
import { call, catalog, login, shop } from './shop.js';

const ORDER = (__ENV.ORDER_LEVELS || '20,40').split(',').filter(Boolean).map(Number);
const RATIO = Number(__ENV.QUERY_RATIO || 20);
const RAMP = Number(__ENV.RAMP || 15);
const HOLD = Number(__ENV.HOLD || 40);
const IDLE = Number(__ENV.IDLE || 180);
const IDLE_ORDER = Number(__ENV.IDLE_ORDER || 1);
const MAX_VUS = Number(__ENV.MAX_VUS || 2000);
const DIRECT_ONLY = __ENV.DIRECT_ONLY === '1';
const GAP = 10;                        // 低流量基準結束後空 10 秒，再開始第一階
const IDLE_VUS = { order: 20, query: 50 };
// 每一種請求分開統計（shop.js 的 step 標籤）：看是哪一種先變慢
export const STEPS = ['catalog', 'login', 'cart', 'cart-clear', 'put', 'put-booking', 'checkout'];

export const levelStart = (i) => (IDLE ? IDLE + GAP : 0) + i * (RAMP + HOLD);   // 第 i 階從第幾秒開始（含爬升）

const scenarios = {};
if (IDLE) {
  scenarios.idle_order = { executor: 'constant-arrival-rate', exec: 'order', rate: IDLE_ORDER, timeUnit: '1s', duration: `${IDLE}s`, preAllocatedVUs: 5, maxVUs: IDLE_VUS.order };
  if (RATIO) scenarios.idle_query = { executor: 'constant-arrival-rate', exec: 'query', rate: IDLE_ORDER * RATIO, timeUnit: '1s', duration: `${IDLE}s`, preAllocatedVUs: 10, maxVUs: IDLE_VUS.query };
}
ORDER.forEach((target, i) => {
  const prev = i ? ORDER[i - 1] : 0;
  const common = { executor: 'ramping-arrival-rate', timeUnit: '1s', startTime: `${levelStart(i)}s`, maxVUs: MAX_VUS };
  // 預先配好這一階要用的虛擬客人：跑到一半才開的話，k6 來不及就會算成「進不來」，那是施壓端的限制、不是系統撐不住
  const preAllocated = (rate) => Math.min(MAX_VUS, Math.max(10, rate * 2));
  scenarios[`order_${i}`] = { ...common, preAllocatedVUs: preAllocated(target), exec: 'order', startRate: prev, stages: [{ target, duration: `${RAMP}s` }, { target, duration: `${HOLD}s` }] };
  if (RATIO) scenarios[`query_${i}`] = { ...common, preAllocatedVUs: preAllocated(target * RATIO), exec: 'query', startRate: prev * RATIO, stages: [{ target: target * RATIO, duration: `${RAMP}s` }, { target: target * RATIO, duration: `${HOLD}s` }] };
});

// k6 只會算「有 threshold 的子指標」：每一階 × 每一種都掛一個永遠成立的 threshold
const LVLS = [...(IDLE ? ['idle'] : []), ...ORDER.map((_, i) => String(i))];
const thresholds = {};
for (const l of LVLS) {
  thresholds[`http_req_duration{lvl:${l},action:catalog}`] = ['p(95)>=0'];
  thresholds[`http_req_duration{lvl:${l},action:checkout,pay:auto}`] = ['p(95)>=0'];
  for (const st of STEPS) thresholds[`http_req_duration{lvl:${l},step:${st}}`] = ['p(95)>=0'];
  for (const kind of ['query', 'order']) {
    thresholds[`http_reqs{lvl:${l},kind:${kind}}`] = ['count>=0'];
    thresholds[`unexpected_responses{lvl:${l},kind:${kind}}`] = ['count>=0'];
    thresholds[`iterations{lvl:${l},kind:${kind}}`] = ['count>=0'];
  }
}
for (const name of Object.keys(scenarios)) thresholds[`dropped_iterations{scenario:${name}}`] = ['count>=0'];

export const options = { scenarios, thresholds, summaryTrendStats: ['count', 'med', 'p(95)', 'p(99)'] };

export function setup() {
  const skus = catalog();
  console.log(`K6_T0 ${Date.now()}`);
  return skus;
}

/** 這一輪屬於哪一階：低流量全程算；加壓的階段只算維持那段 */
function tag(kind) {
  const t = exec.vu.metrics.tags;
  t.kind = kind;
  delete t.pay;
  const name = exec.scenario.name;
  if (name.startsWith('idle_')) t.lvl = 'idle';
  else if (Date.now() - exec.scenario.startTime >= RAMP * 1000) t.lvl = name.split('_')[1];
  else delete t.lvl;
}

export function query() {
  tag('query');
  call('GET', '/catalog', null, 'catalog', [200]);
}

export function order(skus) {
  tag('order');
  login();
  shop(skus, { doubleClickRate: 0, directOnly: DIRECT_ONLY });
}

export function handleSummary(data) {
  const v = (name) => data.metrics[name]?.values;
  const dist = (name) => {
    const x = v(name);
    return x?.count ? { n: x.count, p50: x.med, p95: x['p(95)'], p99: x['p(99)'] } : null;
  };
  const count = (name) => v(name)?.count ?? 0;
  const seconds = (l) => (l === 'idle' ? IDLE : HOLD);
  const levels = LVLS.map((l) => {
    const success = (kind) => {
      const n = count(`http_reqs{lvl:${l},kind:${kind}}`);
      return n ? 1 - count(`unexpected_responses{lvl:${l},kind:${kind}}`) / n : null;
    };
    const i = Number(l);
    return {
      lvl: l,
      target: l === 'idle' ? { order: IDLE_ORDER, query: IDLE_ORDER * RATIO } : { order: ORDER[i], query: ORDER[i] * RATIO },
      achieved: { order: Math.round(count(`iterations{lvl:${l},kind:order}`) / seconds(l)), query: Math.round(count(`iterations{lvl:${l},kind:query}`) / seconds(l)) },
      // 進不來：這一階的 scenario（含爬升）k6 開不出虛擬客人的次數
      dropped: l === 'idle' ? count('dropped_iterations{scenario:idle_order}') : count(`dropped_iterations{scenario:order_${i}}`),
      droppedQuery: l === 'idle' ? count('dropped_iterations{scenario:idle_query}') : count(`dropped_iterations{scenario:query_${i}}`),
      success: { order: success('order'), query: success('query') },
      query: dist(`http_req_duration{lvl:${l},action:catalog}`),
      pay_api: dist(`http_req_duration{lvl:${l},action:checkout,pay:auto}`),
      steps: Object.fromEntries(STEPS.map((st) => [st, dist(`http_req_duration{lvl:${l},step:${st}}`)])),
    };
  });
  return { stdout: `K6_RESULT ${JSON.stringify({ levels, levelStarts: ORDER.map((_, i) => levelStart(i)), ramp: RAMP, hold: HOLD, idle: IDLE })}\n` };
}
