// 20 個客人各下 3 輪：混合直送、寄倉、預約
import { catalog, login, shop, skipped } from '../../sandbox/k6/shop.js';

export const options = {
  scenarios: { shoppers: { executor: 'per-vu-iterations', vus: 20, iterations: 3, maxDuration: '5m' } },   // 每個客人固定跑 3 輪 → 第幾個客人第幾輪每次都一樣
  thresholds: { unexpected_responses: ['count==0'] },
};

export const setup = () => catalog();

export default function (skus) {
  if (skipped()) return;
  login();
  shop(skus);
}
