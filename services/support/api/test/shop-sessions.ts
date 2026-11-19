import { randomBytes } from 'node:crypto';
import type { ShopIdentity, ShopSessions } from '../src/auth/shop-session.js';
import type { Client } from './http.js';

// 測試用的商店登入（AIC-015）：sid → 客戶。正式環境由 BFF 解析
export const SHOP_CUSTOMERS = {
  'alice@example.test': { customerId: 1, name: 'Alice' },
  'bob@example.test': { customerId: 2, name: 'Bob' },
} as const satisfies Record<string, ShopIdentity>;
export type ShopEmail = keyof typeof SHOP_CUSTOMERS;

export class FakeShopSessions implements ShopSessions {
  readonly sids = new Map<string, ShopIdentity>();
  async resolve(sid: string | undefined) {
    return (sid && this.sids.get(sid)) || null;
  }
}
export const fakeSessions = new FakeShopSessions();

/** 像在商店登入：拿到 sid cookie，再向 support 開 session */
export async function loginCustomer(c: Client, email: string) {
  const who = SHOP_CUSTOMERS[email as ShopEmail];
  if (!who) throw new Error(`商店沒有這位客戶：${email}`);
  const sid = randomBytes(16).toString('hex');
  fakeSessions.sids.set(sid, who);
  c.cookies.set('sid', sid);
  return c.post('/api/auth/customer/session');
}

/** 像在商店登出：sid 失效（cookie 還在，BFF 說無效） */
export function logoutShop(c: Client) {
  fakeSessions.sids.delete(c.cookies.get('sid') ?? '');
}
