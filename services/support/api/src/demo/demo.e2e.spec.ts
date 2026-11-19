import type { INestApplication } from '@nestjs/common';
import { loginCustomer } from '../../test/shop-sessions.js';
import type { Pool } from 'mysql2/promise';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { fakeShop } from '../../test/fake-shop.js';
import { Client, startApp } from '../../test/http.js';
import { seed } from '../db/seed.js';

let db: Pool;
let app: INestApplication;
let url: string;
beforeAll(async () => {
  db = testDb();
  ({ app, url } = await startApp());
});
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await truncate(db);
  await seed(db, testEnv);
  fakeShop.reset();
});

const staff = async () => {
  const c = new Client(url);
  await c.post('/api/auth/staff/login', {
    email: 'support@example.test',
    password: '0204',
  });
  return c;
};

// 測試訂單改在商店下（AIC-014）；物流開關改的是 partners（AIC-017，測試用假的）
describe('demo 面板', () => {
  it('客戶和未登入的人改不了設定', async () => {
    const alice = new Client(url);
    await loginCustomer(alice, 'alice@example.test');
    for (const c of [alice, new Client(url)]) {
      expect(
        (await c.post('/api/console/demo/settings', { support_demo: 'on' }))
          .status,
      ).toBe(401);
    }
  });

  it('員工可以開關：大型物流 demo 打開後，貓砂的預估變成 20 分鐘', async () => {
    const s = await staff();
    expect((await s.get('/api/console/demo')).body).toEqual({
      support_demo: 'off',
      logistics_down: 'off',
    });
    expect(
      (await s.post('/api/console/demo/settings', { support_demo: 'on' })).body,
    ).toEqual({ support_demo: 'on', logistics_down: 'off' });
    expect((await fakeShop.deliveryEstimate('DCS-LIT-1'))?.estimated_seconds).toBe(1200);
    expect((await fakeShop.deliveryEstimate('DCS-CAN-DUCK-80'))?.estimated_seconds).toBe(4.5);
  });

  it('設定不合法回 400', async () => {
    const s = await staff();
    expect(
      (await s.post('/api/console/demo/settings', { support_demo: 'maybe' }))
        .status,
    ).toBe(400);
  });

  it('建測試訂單的端點已經拿掉', async () => {
    const s = await staff();
    expect(
      (await s.post('/api/console/demo/orders', { email: 'alice@example.test', sku: 'DCS-LIT-1' })).status,
    ).toBe(404);
  });
});
