// 找上限（scripts/k8s.sh stress）：查詢和下單分開，一階一階往上加，看在哪一階開始變慢或出錯
//   READ_LEVELS=200,500,1000   每秒查詢數（看商品列表，不用登入）
//   ORDER_LEVELS=20,40,80      每秒下單數（完整購物流程：登入、購物車、結帳）
//   RAMP=15s HOLD=40s          每一階先爬升 RAMP，再維持 HOLD；只統計「維持」的那段
// 兩邊的階數不一樣時，少的那邊維持在最後一階
import http from 'k6/http';
import exec from 'k6/execution';
import { BASE, catalog, login, shop } from './shop.js';

const levels = (s) => (s || '').split(',').filter(Boolean).map(Number);
const READ = levels(__ENV.READ_LEVELS);
const ORDER = levels(__ENV.ORDER_LEVELS);
const RAMP = Number((__ENV.RAMP || '15s').replace('s', ''));
const HOLD = Number((__ENV.HOLD || '40s').replace('s', ''));
const STEPS = Math.max(READ.length, ORDER.length);
const HOST = __ENV.HOST || '';

const at = (list, i) => list[Math.min(i, list.length - 1)];
const stagesFor = (list) => Array.from({ length: STEPS }, (_, i) => [
  { target: at(list, i), duration: `${RAMP}s` },
  { target: at(list, i), duration: `${HOLD}s` },
]).flat().concat([{ target: 0, duration: '10s' }]);

const scenarios = {};
if (READ.length) scenarios.read = { executor: 'ramping-arrival-rate', exec: 'read', startRate: 0, timeUnit: '1s', preAllocatedVUs: 200, maxVUs: 1500, stages: stagesFor(READ) };
if (ORDER.length) scenarios.order = { executor: 'ramping-arrival-rate', exec: 'order', startRate: 0, timeUnit: '1s', preAllocatedVUs: 100, maxVUs: 400, stages: stagesFor(ORDER) };

// 每一階、每一種各一組子指標（k6 的 summary 只會算有 threshold 的子指標）
const thresholds = {};
for (let i = 0; i < STEPS; i++) {
  for (const kind of ['read', 'order']) {
    thresholds[`http_req_duration{lvl:${i},kind:${kind}}`] = ['p(95)>=0'];
    thresholds[`http_req_failed{lvl:${i},kind:${kind}}`] = ['rate>=0'];
    thresholds[`iterations{lvl:${i},kind:${kind}}`] = ['count>=0'];
  }
}

export const options = { scenarios, thresholds, summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'] };

export const setup = () => catalog();

/** 現在在第幾階的「維持」段；爬升段回傳 null（不統計） */
function holdLevel() {
  const t = exec.instance.currentTestRunDuration / 1000;
  const step = Math.floor(t / (RAMP + HOLD));
  return step < STEPS && t - step * (RAMP + HOLD) >= RAMP ? step : null;
}

function tag(kind) {
  const lvl = holdLevel();
  exec.vu.metrics.tags.kind = kind;
  if (lvl === null) delete exec.vu.metrics.tags.lvl; else exec.vu.metrics.tags.lvl = String(lvl);
}

export function read() {
  tag('read');
  http.get(`${BASE}/catalog`, { headers: Object.assign(HOST ? { Host: HOST } : {}, { Accept: 'application/json' }), tags: { action: 'catalog' } });
}

export function order(skus) {
  tag('order');
  login();
  shop(skus, { doubleClickRate: 0 });
}

export function handleSummary(data) {
  const m = (name) => data.metrics[name]?.values;
  const rows = ['', `每一階維持 ${HOLD} 秒的結果（目標 → 實際每秒、p95、錯誤率）`, ''];
  for (let i = 0; i < STEPS; i++) {
    const cell = (kind, list) => {
      if (!list.length) return '-';
      const it = m(`iterations{lvl:${i},kind:${kind}}`)?.count ?? 0;
      const p95 = m(`http_req_duration{lvl:${i},kind:${kind}}`)?.['p(95)'];
      const fail = m(`http_req_failed{lvl:${i},kind:${kind}}`)?.rate ?? 0;
      return `${at(list, i)} → ${(it / HOLD).toFixed(0)}/s  p95 ${p95 == null ? '-' : Math.round(p95) + 'ms'}  錯誤 ${(fail * 100).toFixed(1)}%`;
    };
    rows.push(`第 ${i + 1} 階   查詢 ${cell('read', READ)}   ｜   下單 ${cell('order', ORDER)}`);
  }
  const dropped = m('dropped_iterations')?.count ?? 0;
  rows.push('', `k6 來不及送出的（客人進不來）：${dropped}`, '');
  return { stdout: rows.join('\n') };
}
