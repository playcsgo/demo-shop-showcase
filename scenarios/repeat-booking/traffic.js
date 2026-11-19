// 10 個客人，每人 3 輪，每一輪都預約同一個時段（每個客人自己的固定時段）
import { call, catalog, checkout, clearCart, login, put, skipped } from '../../sandbox/k6/shop.js';

export const options = {
  scenarios: { shoppers: { executor: 'per-vu-iterations', vus: 10, iterations: 3, maxDuration: '5m' } },
  thresholds: { unexpected_responses: ['count==0'] },
};
export const setup = () => catalog();
export default function (skus) {
  if (skipped()) return;
  login();
  clearCart();
  const at = new Date(Date.now() + (7 + __VU) * 86400000);   // 第 N 個客人固定訂 7+N 天後
  at.setUTCHours(6, 0, 0, 0);                                   // 台北下午 2 點
  put(skus, 'DCS-SVC-HEALTH', 'booking', 1, { appointment_at: at.toISOString() });
  checkout();
}
