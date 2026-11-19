import type { Pool } from 'mysql2/promise';
import { fakeShop } from './fake-shop.js';
import { SHOP_CUSTOMERS } from './shop-sessions.js';

/**
 * 測試用的商店資料（假的商店）：重設後放兩張訂單，A-1 屬於 alice，B-1 屬於 bob。
 * 客戶 id 是商店的（AIC-015），和 loginCustomer() 用的同一組
 */
export async function shopFixture(_db?: Pool) {
  fakeShop.reset();
  fakeShop.customers = Object.entries(SHOP_CUSTOMERS).map(([email, c]) => ({ id: c.customerId, name: c.name, email }));
  const alice = SHOP_CUSTOMERS['alice@example.test'].customerId;
  const bob = SHOP_CUSTOMERS['bob@example.test'].customerId;
  fakeShop.createOrder(
    alice,
    [
      { sku: 'DCS-CAN-DUCK-80', qty: 6 },
      { sku: 'DCS-PRO-30', qty: 1 },
    ],
    { orderNo: 'A-1', status: 'delivered' },
  );
  fakeShop.createOrder(bob, [{ sku: 'DCS-DH-M', qty: 1 }], { orderNo: 'B-1', status: 'shipped' });
  return { alice, bob };
}

export { fakeShop };
