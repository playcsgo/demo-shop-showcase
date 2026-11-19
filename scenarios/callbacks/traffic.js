// 20 個客人各下 3 輪
import { catalog, login, shop, skipped } from '../../sandbox/k6/shop.js';

export const options = {
  scenarios: { shoppers: { executor: 'per-vu-iterations', vus: 20, iterations: 3, maxDuration: '10m' } },
  thresholds: { unexpected_responses: ['count==0'] },
};
export const setup = () => catalog();
export default function (skus) {
  if (skipped()) return;
  login();
  shop(skus);
}
