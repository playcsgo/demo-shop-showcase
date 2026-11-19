import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BffShopSessions, CACHE_MS } from './shop-session.js';

// 假的 BFF：記下每次收到的 sid
let server: Server;
let base: string;
let calls: { key: string | undefined; sid: string }[] = [];
let status = 200;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const { sid } = JSON.parse(body) as { sid: string };
      calls.push({ key: req.headers['x-service-key'] as string, sid });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(sid === 'alice' ? { valid: true, customer_id: 1, name: 'Alice' } : { valid: false }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((ok) => server.close(ok)));
beforeEach(() => {
  calls = [];
  status = 200;
  vi.useRealTimers();
});

describe('BffShopSessions', () => {
  it('有效的 sid → 客戶；帶 support 的金鑰；sid 放 body', async () => {
    const s = new BffShopSessions(base, 'k');
    expect(await s.resolve('alice')).toEqual({ customerId: 1, name: 'Alice' });
    expect(calls).toEqual([{ key: 'k', sid: 'alice' }]);
  });

  it('30 秒內同一個 sid 不再問 BFF；過了就重問（登出最晚 30 秒生效）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = new BffShopSessions(base, 'k');
    await s.resolve('alice');
    await s.resolve('alice');
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + CACHE_MS + 1);
    await s.resolve('alice');
    expect(calls).toHaveLength(2);
  });

  it('無效、沒帶、太長的 sid：null；太長的不呼叫', async () => {
    const s = new BffShopSessions(base, 'k');
    expect(await s.resolve('nope')).toBeNull();
    expect(await s.resolve(undefined)).toBeNull();
    expect(await s.resolve('x'.repeat(101))).toBeNull();
    expect(calls.map((c) => c.sid)).toEqual(['nope']);
  });

  it('BFF 掛了：當成匿名，而且不快取，恢復後馬上認得人', async () => {
    const down = new BffShopSessions('http://127.0.0.1:1', 'k');
    expect(await down.resolve('alice')).toBeNull();
    status = 500;
    const s = new BffShopSessions(base, 'k');
    expect(await s.resolve('alice')).toBeNull();
    status = 200;
    expect(await s.resolve('alice')).toEqual({ customerId: 1, name: 'Alice' });
  });

  it('沒設定網址或金鑰：啟動就失敗', () => {
    expect(() => new BffShopSessions('', 'k')).toThrow();
    expect(() => new BffShopSessions(base, '')).toThrow();
  });
});
