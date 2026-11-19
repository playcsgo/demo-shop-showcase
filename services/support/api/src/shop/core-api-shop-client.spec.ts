import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CoreApiShopClient } from './core-api-shop-client.js';
import { ShopUnavailable } from './shop-client.js';
import { ProductIndex } from './product-index.js';

// 假的 core-api：記下收到的請求，回應由每個測試決定
let server: Server;
let base: string;
let seen: IncomingMessage[] = [];
let reply: (req: IncomingMessage) => { status: number; body?: unknown; delayMs?: number };

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    const r = reply(req);
    setTimeout(() => {
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body ?? {}));
    }, r.delayMs ?? 0);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((ok) => server.close(ok)));
beforeEach(() => {
  seen = [];
  reply = () => ({ status: 200, body: { data: [] } });
});

const client = () => new CoreApiShopClient(base, 'k-1');

describe('CoreApiShopClient', () => {
  it('帶服務金鑰、身分和 correlation id；路徑照 internal support API', async () => {
    reply = () => ({ status: 200, body: { data: { order_no: 'A-1' } } });
    expect(await client().order(7, 'A-1', 'staff:3')).toEqual({ order_no: 'A-1' });
    expect(seen[0].url).toBe('/api/v1/internal/support/customers/7/orders/A-1');
    expect(seen[0].headers).toMatchObject({ 'x-service-key': 'k-1', 'x-support-actor': 'staff:3' });
    expect(seen[0].headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('404 → null（不存在和不是這位客戶的，core-api 不分）', async () => {
    reply = () => ({ status: 404, body: { error: 'not_found' } });
    expect(await client().order(7, 'B-1', 'customer:7')).toBeNull();
    expect(await client().variant('NOPE')).toBeNull();
  });

  it('AC-43：401、500、逾時 → ShopUnavailable，不重試', async () => {
    for (const [r, reason] of [
      [{ status: 401 }, 'http_401'],
      [{ status: 500 }, 'http_500'],
      [{ status: 200, body: { data: [] }, delayMs: 3500 }, 'timeout'],
    ] as const) {
      reply = () => r;
      seen = [];
      const err = await client().orders(7, 'customer:7').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShopUnavailable);
      expect((err as ShopUnavailable).reason).toBe(reason);
      expect(seen).toHaveLength(1);
    }
  }, 10_000);

  it('商店沒開：ShopUnavailable(network)', async () => {
    const err = await new CoreApiShopClient('http://127.0.0.1:1', 'k').productIndex().catch((e: unknown) => e);
    expect((err as ShopUnavailable).reason).toBe('network');
  });

  it('路徑參數會編碼：訂單號裡的 / 和 ? 不能改變路徑', async () => {
    reply = () => ({ status: 404 });
    await client().order(7, '../../products?x=1', 'customer:7');
    expect(seen[0].url).toBe('/api/v1/internal/support/customers/7/orders/..%2F..%2Fproducts%3Fx%3D1');
  });

  it('找客戶：太短或有萬用字元就不呼叫', async () => {
    expect(await client().findCustomers('a', 'staff:1')).toEqual([]);
    expect(await client().findCustomers('a%', 'staff:1')).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('沒設定網址或金鑰：啟動就失敗', () => {
    expect(() => new CoreApiShopClient('', 'k')).toThrow();
    expect(() => new CoreApiShopClient(base, '')).toThrow();
  });
});

describe('CoreApiShopClient 退款（AIC-016）', () => {
  it('申請：202 → accepted；body 帶明細、冪等鍵、客服；身分是 staff', async () => {
    let body = '';
    reply = (req) => {
      req.on('data', (d) => (body += d));
      return { status: 202, body: { data: { refund_id: 9, status: 'PENDING', amount: 96 } } };
    };
    const r = await client().requestRefund(1, 'A-1', { lines: { 5: 2 }, idempotencyKey: 'support-proposal:p', staffId: 3, proposalId: 'p' });
    expect(r).toEqual({ status: 'accepted', refundId: '9', amount: 96 });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/v1/internal/support/customers/1/orders/A-1/refunds' });
    expect(seen[0].headers['x-support-actor']).toBe('staff:3');
    await new Promise((ok) => setTimeout(ok, 10));
    expect(JSON.parse(body)).toEqual({ lines: { 5: 2 }, idempotency_key: 'support-proposal:p', staff_id: 3, proposal_id: 'p' });
  });

  it('申請：409 → 商店擋下的代碼；404 → not_found；500 → ShopUnavailable', async () => {
    reply = () => ({ status: 409, body: { error: 'refund_window_expired' } });
    const req = { lines: { 5: 1 }, idempotencyKey: 'k', staffId: 3, proposalId: 'p' };
    expect(await client().requestRefund(1, 'A-1', req)).toEqual({ status: 'rejected', code: 'refund_window_expired' });
    reply = () => ({ status: 404 });
    expect(await client().requestRefund(1, 'B-1', req)).toEqual({ status: 'rejected', code: 'not_found' });
    reply = () => ({ status: 500 });
    await expect(client().requestRefund(1, 'A-1', req)).rejects.toBeInstanceOf(ShopUnavailable);
  });

  it('預覽和查結果', async () => {
    reply = () => ({ status: 200, body: { data: { eligible: false, code: 'refund_window_expired', amount: 48 } } });
    expect(await client().refundPreview(1, 'A-1', { 5: 1 })).toEqual({ eligible: false, code: 'refund_window_expired', amount: 48 });
    reply = () => ({ status: 200, body: { data: { refund_id: 9, status: 'SUCCEEDED', amount: 96, order_status: 'PARTIALLY_REFUNDED' } } });
    expect(await client().refundStatus('9')).toMatchObject({ status: 'SUCCEEDED', order_status: 'PARTIALLY_REFUNDED' });
    expect(seen.at(-1)!.url).toBe('/api/v1/internal/support/refunds/9');
  });
});

describe('ProductIndex（AC-41）', () => {
  const entry = (slug: string) => ({ slug, name: slug, category: null, brand: 'b', species: ['cat'], life_stage: [], concerns: ['digestive'] });

  it('拉到的索引變成提示用的文字；更新失敗沿用舊的', async () => {
    reply = () => ({ status: 200, body: { data: [entry('probiotics')] } });
    const index = new ProductIndex(client());
    expect(await index.text()).toBe('probiotics｜probiotics｜cat｜digestive');
    reply = () => ({ status: 500 });
    await index.refresh();
    expect(await index.text()).toBe('probiotics｜probiotics｜cat｜digestive');
    reply = () => ({ status: 200, body: { data: [entry('probiotics'), entry('lick-mat')] } });
    await index.refresh();
    expect(await index.text()).toContain('lick-mat');
  });
});
