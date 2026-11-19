import { createHash } from 'node:crypto';
import { loginCustomer, logoutShop } from '../../test/shop-sessions.js';
import type { INestApplication } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { Client, startApp } from '../../test/http.js';
import { seed } from '../db/seed.js';

let db: Pool;
let app: INestApplication;
let url: string;
let logs: () => string;
let waitForLog: (needle: string) => Promise<void>;
// 一個檔案只起一個 app：nestjs-pino 的 logger 是全域的，兩個 app 會互相干擾
beforeAll(async () => {
  db = testDb();
  ({ app, url, logs, waitForLog } = await startApp());
});
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await truncate(db);
  await seed(db, testEnv);
});

const login = async (
  who: 'staff',
  email: string,
  password = '0204',
) => {
  const c = new Client(url);
  const res = await c.post(`/api/auth/${who}/login`, { email, password });
  return { c, res };
};
const shopLogin = async (email: 'alice@example.test' | 'bob@example.test') => {
  const c = new Client(url);
  const res = await loginCustomer(c, email);
  return { c, res };
};

describe('客戶身分來自商店的登入（AIC-015）', () => {
  it('AC-31：帶商店的 sid 開 session，認得是 alice；cookie 是 HttpOnly、SameSite=Lax', async () => {
    const { c, res } = await shopLogin('alice@example.test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 1, name: 'Alice', anonymous: false });
    expect(res.setCookie[0]).toMatch(/^support_customer=[^;]+; .*HttpOnly/);
    expect(res.setCookie[0]).toContain('SameSite=Lax');
    expect((await c.get('/api/auth/customer/me')).body).toMatchObject({ name: 'Alice', anonymous: false });
  });

  it('AC-32：沒有 sid、sid 無效：匿名', async () => {
    const c = new Client(url);
    expect((await c.post('/api/auth/customer/session')).body).toEqual({ anonymous: true });
    const forged = new Client(url);
    forged.cookies.set('sid', 'made-up');
    expect((await forged.post('/api/auth/customer/session')).body).toEqual({ anonymous: true });
  });

  it('AC-33：support 不收客戶密碼，也沒有客戶帳號表', async () => {
    const c = new Client(url);
    expect((await c.post('/api/auth/customer/login', { email: 'alice@example.test', password: '0204' })).status).toBe(404);
    const [rows] = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'customers'",
    );
    expect(rows).toEqual([]);
  });

  it('AC-34：在商店登出後，這個 session 作廢，要重新開一個（變成匿名）', async () => {
    const { c } = await shopLogin('alice@example.test');
    const old = c.cookies.get('support_customer')!;
    logoutShop(c);
    expect((await c.get('/api/auth/customer/me')).status).toBe(401);
    expect((await c.post('/api/auth/customer/session')).body).toEqual({ anonymous: true });
    expect(c.cookies.get('support_customer')).not.toBe(old);
  });

  it('換帳號登入：alice 的 session 作廢，bob 拿到新的；alice 的 session 不能被 bob 接續', async () => {
    const { c } = await shopLogin('alice@example.test');
    const aliceSession = c.cookies.get('support_customer')!;
    await loginCustomer(c, 'bob@example.test'); // 同一個瀏覽器換成 bob 的 sid
    expect((await c.get('/api/auth/customer/me')).body).toMatchObject({ name: 'Bob' });
    const replay = new Client(url);
    replay.cookies.set('support_customer', aliceSession);
    replay.cookies.set('sid', c.cookies.get('sid')!);
    expect((await replay.get('/api/auth/customer/me')).status).toBe(401);
  });

  it('沒登入商店時拿匿名 session；登入商店後換成新的 session，舊的匿名作廢', async () => {
    const c = new Client(url);
    await c.post('/api/auth/customer/session');
    const anon = c.cookies.get('support_customer')!;
    await loginCustomer(c, 'alice@example.test');
    expect(c.cookies.get('support_customer')).not.toBe(anon);
    const replay = new Client(url);
    replay.cookies.set('support_customer', anon);
    replay.cookies.set('sid', c.cookies.get('sid')!);
    expect((await replay.get('/api/auth/customer/me')).status).toBe(401);
  });

  it('已經有有效的 session 時，不會再發一個新的', async () => {
    const { c } = await shopLogin('alice@example.test');
    const before = c.cookies.get('support_customer');
    await c.post('/api/auth/customer/session');
    expect(c.cookies.get('support_customer')).toBe(before);
  });

  it('資料庫只存 cookie 的雜湊，sid 原文不進資料庫', async () => {
    const { c } = await shopLogin('alice@example.test');
    const token = c.cookies.get('support_customer')!;
    const [rows] = await db.query('SELECT token_hash FROM sessions');
    expect(rows).toEqual([{ token_hash: createHash('sha256').update(token).digest('hex') }]);
    const [dump] = await db.query<RowDataPacket[]>('SELECT * FROM sessions, shop_customers');
    expect(JSON.stringify(dump)).not.toContain(c.cookies.get('sid')!);
  });

  it('support 登出後舊 cookie 失效；過期的 session 被拒', async () => {
    const { c } = await shopLogin('alice@example.test');
    const old = c.cookies.get('support_customer')!;
    await c.post('/api/auth/customer/logout');
    const replay = new Client(url);
    replay.cookies.set('support_customer', old);
    expect((await replay.get('/api/auth/customer/me')).status).toBe(401);
    const { c: c2 } = await shopLogin('alice@example.test');
    await db.query('UPDATE sessions SET expires_at = NOW(3) - INTERVAL 1 SECOND');
    expect((await c2.get('/api/auth/customer/me')).status).toBe(401);
  });
});

describe('員工登入', () => {
  it('客服和獸醫的角色正確', async () => {
    const support = await login('staff', 'support@example.test');
    const vet = await login('staff', 'vet@example.test');
    expect((await support.c.get('/api/auth/staff/me')).body).toMatchObject({
      role: 'support_agent',
    });
    expect((await vet.c.get('/api/auth/staff/me')).body).toMatchObject({
      role: 'vet',
    });
  });

  it('客戶的 session 不能當員工用，就算塞進員工的 cookie 名稱', async () => {
    const { c } = await shopLogin('alice@example.test');
    const forged = new Client(url);
    forged.cookies.set('support_staff', c.cookies.get('support_customer')!);
    expect((await forged.get('/api/auth/staff/me')).status).toBe(401);
  });

});

describe('跨站請求', () => {
  it('Origin 不是自己的前台時，會改狀態的請求被拒', async () => {
    const c = new Client(url);
    const res = await c.post(
      '/api/auth/staff/login',
      { email: 'support@example.test', password: '0204' },
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(res.setCookie).toEqual([]);
  });

  it('登入的請求格式不對回 400，不是 500', async () => {
    const c = new Client(url);
    expect(
      (await c.post('/api/auth/staff/login', { email: 1 })).status,
    ).toBe(400);
  });
});

describe('log', () => {
  it('不記錄密碼、cookie、email', async () => {
    const c = new Client(url);
    await c.post('/api/auth/staff/login', { email: 'support@example.test', password: '0204' });
    await loginCustomer(c, 'alice@example.test');
    await c.get('/api/auth/customer/me');
    // 確定請求真的有記下來（啟動時的路由 log 也有路徑，所以比對請求 log 的格式）
    await waitForLog('"url":"/api/auth/customer/me"},"res":{"statusCode":200}');
    await waitForLog(
      '"url":"/api/auth/staff/login"},"res":{"statusCode":200}',
    );
    expect(logs()).not.toContain('support@example.test');
    expect(logs()).not.toContain(c.cookies.get('sid')!);
    expect(logs()).not.toContain('"0204"'); // 只比對字串值：時間戳和 pid 也可能含這四個數字
    expect(logs()).not.toMatch(/"password"/);
    expect(logs()).not.toContain(c.cookies.get('support_customer')!);
  });
});
