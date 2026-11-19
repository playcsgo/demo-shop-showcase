// 10 個客人各下 1 輪（結帳本身會成功：付款是背景處理）
import { catalog, login, shop, skipped } from '../../sandbox/k6/shop.js';

export const options = {
  scenarios: { shoppers: { executor: 'per-vu-iterations', vus: 10, iterations: 1, maxDuration: '5m' } },
  thresholds: { unexpected_responses: ['count==0'] },
};
export const setup = () => catalog();
export default function (skus) {
  if (skipped()) return;
  login();
  shop(skus);
}
