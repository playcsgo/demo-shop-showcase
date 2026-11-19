// 30 個客人各下 2 輪；20% 的人結帳連按兩下
import { catalog, login, shop, skipped } from '../../sandbox/k6/shop.js';

export const options = {
  scenarios: { shoppers: { executor: 'per-vu-iterations', vus: 30, iterations: 2, maxDuration: '10m' } },
  thresholds: { unexpected_responses: ['count==0'] },
};
export const setup = () => catalog();
export default function (skus) {
  if (skipped()) return;
  login();
  shop(skus, { doubleClickRate: 0.2 });
}
