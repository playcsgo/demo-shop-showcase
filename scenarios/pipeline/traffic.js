// 固定「每秒幾筆訂單」送進來（constant-arrival-rate），只買直送商品：沒有寄倉、預約的分支，量的是訂單流程本身
// RATE、DURATION 由 runner 每一段傳進來
import { catalog, login, shop } from '../../sandbox/k6/shop.js';

export const options = {
  scenarios: {
    load: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 1), timeUnit: '1s', duration: __ENV.DURATION || '3m', preAllocatedVUs: 50, maxVUs: 400 },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: { 'http_req_duration{action:checkout}': ['p(95)<60000'] },   // 只是為了讓報告有「結帳」這一項的數字
};
export const setup = () => catalog();
export default function (skus) {
  login();
  shop(skus, { doubleClickRate: 0, directOnly: true });
}
