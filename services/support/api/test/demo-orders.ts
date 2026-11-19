import type { FakeShop } from './fake-shop.js';
import { SHOP_CUSTOMERS } from './shop-sessions.js';

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);

/**
 * demo 情境的訂單（spec §9），回歸測試用。正式 demo 的同一組訂單由 core-api 的 SupportDemoOrders 建立（AIC-014）。
 * 送達時間直接指定：超期的案例不能真的等 7 天
 */
export const DEMO_ORDERS = [
  // 3 天前送達：可以退款；益生菌有不適用警示
  { orderNo: 'DEMO-A', email: 'alice@example.test', items: [{ sku: 'DCS-PRO-30', qty: 1 }, { sku: 'DCS-CAN-DUCK-80', qty: 6 }], deliveredAgo: 3 * DAY },
  // 30 天前送達：超過期限
  { orderNo: 'DEMO-B', email: 'alice@example.test', items: [{ sku: 'DCS-KIB-1500', qty: 1 }], deliveredAgo: 30 * DAY },
  // 貓砂運送中：「東西怎麼還沒到」
  { orderNo: 'DEMO-C', email: 'alice@example.test', items: [{ sku: 'DCS-LIT-1', qty: 1 }], deliveredAgo: null },
  // bob 的狗屋運送中：alice 查別人的訂單會被擋
  { orderNo: 'DEMO-D', email: 'bob@example.test', items: [{ sku: 'DCS-DH-M', qty: 1 }], deliveredAgo: null },
  // 剛好超過 7 天幾個小時：AI 看日期容易判斷成還可以退，核准時會被系統擋下（AC-13）
  { orderNo: 'DEMO-E', email: 'alice@example.test', items: [{ sku: 'DCS-JNT-60', qty: 1 }], deliveredAgo: 7 * DAY + 3 * 3_600_000 },
] as const;

export async function seedDemoOrders(shop: FakeShop) {
  for (const o of DEMO_ORDERS) {
    const customer = SHOP_CUSTOMERS[o.email].customerId;
    const deliveredAt = o.deliveredAgo === null ? null : ago(o.deliveredAgo);
    shop.createOrder(customer, [...o.items], {
      orderNo: o.orderNo,
      status: deliveredAt ? 'delivered' : 'shipped',
      createdAt: deliveredAt ? new Date(deliveredAt.getTime() - DAY) : ago(15 * 60_000),
      deliveredAt,
    });
  }
}
