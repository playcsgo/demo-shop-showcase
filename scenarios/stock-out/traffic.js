// 10 個客人同時買 1 個狗屋：先全部登入、加入購物車，再同一瞬間結帳（併發正確性）
import { Counter } from 'k6/metrics';
import { catalog, checkout, clearCart, login, put, skipped } from '../../sandbox/k6/shop.js';

const bought = new Counter('bought');
const soldOut = new Counter('sold_out');

export const options = {
  scenarios: { rush: { executor: 'per-vu-iterations', vus: 10, iterations: 1, maxDuration: '2m' } },
  thresholds: {
    unexpected_responses: ['count==0'],
    bought: ['count==3'],       // 剛好 3 個人買到
    sold_out: ['count==7'],     // 其他 7 個人都收到「庫存不足」
  },
};
export const setup = () => catalog();
export default function (skus) {
  if (skipped()) return;
  login();
  clearCart();
  put(skus, 'DCS-DH-M', 'direct', 1);
  // 對齊到下一個整秒再結帳：10 個人幾乎同時送出
  const wait = 1000 - (Date.now() % 1000);
  if (wait < 1000) { const until = Date.now() + wait; while (Date.now() < until) { /* busy wait，k6 的 sleep 精度不夠 */ } }
  const res = checkout([201, 409]);
  if (res.status === 201) bought.add(1);
  else if (res.json('error') === 'insufficient_stock') soldOut.add(1);
}
