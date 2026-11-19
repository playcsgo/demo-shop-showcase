import type { INestApplication } from '@nestjs/common';
import { loginCustomer } from './shop-sessions.js';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Socket } from 'socket.io-client';
import { seed } from '../src/db/seed.js';
import { testDb, testEnv, truncate } from './db.js';
import { shopFixture } from './fixtures.js';
import { Client, startApp } from './http.js';
import { realRunner } from './real-helpers.js';
import { ack, connect, record } from './socket.js';

// AIC-004：真的 CLI＋真的模型走完整條路。花額度，手動跑：scripts/support.sh llm ask
if (process.env.SUPPORT_CONTAINER !== '1') throw new Error('只能在容器裡跑');

let db: Pool;
let app: INestApplication;
let url: string;
const sockets: Socket[] = [];
beforeAll(async () => {
  db = testDb();
  ({ app, url } = await startApp({ llm: realRunner() }));
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await truncate(db);
  await seed(db, testEnv);
  await shopFixture(db);
});

async function ask(question: string, email?: string) {
  const c = new Client(url);
  if (email)
    await loginCustomer(c, email);
  else await c.post('/api/auth/customer/session');
  const conv = (await c.post('/api/conversations', { mode: 'ask' })).body;
  const socket = await connect(url, '/customer', c);
  sockets.push(socket);
  await ack(socket, 'join', { conversationId: conv.id });
  const messages = record<{
    sender: string;
    body: string;
    refs_json: Record<string, unknown> | null;
  }>(socket, 'message');
  const logins = record(socket, 'ask:login');
  await ack(socket, 'send', { conversationId: conv.id, body: question });
  const end = Date.now() + 150_000;
  while (!messages.some((m) => m.sender === 'ai') && Date.now() < end)
    await new Promise((r) => setTimeout(r, 200));
  const [calls] = await db.query<RowDataPacket[]>(
    'SELECT t.tool, t.status FROM tool_calls t JOIN ai_runs r ON r.id = t.run_id WHERE r.conversation_id = ? ORDER BY t.created_at',
    [conv.id],
  );
  const [[run]] = await db.query<RowDataPacket[]>(
    'SELECT status, error_code FROM ai_runs WHERE conversation_id = ?',
    [conv.id],
  );
  const answer = messages.find((m) => m.sender === 'ai');
  console.log(
    `  [${question}] run=${run?.status}/${run?.error_code ?? '-'} tools=${calls.map((c) => `${c.tool}:${c.status}`).join(',')} refs=${Object.keys(answer?.refs_json ?? {}).join(',')}`,
  );
  return {
    answer,
    calls: calls as { tool: string; status: string }[],
    run,
    logins,
    messages,
  };
}

it('匿名問庫存：查工具、附引用', async () => {
  const r = await ask('寵物益生菌現在有貨嗎？');
  expect(r.run.status).toBe('done');
  expect(
    r.calls.some(
      (c) =>
        ['get_stock', 'list_variants'].includes(c.tool) && c.status === 'ok',
    ),
  ).toBe(true);
  expect(Object.keys(r.answer?.refs_json ?? {}).length).toBeGreaterThan(0);
});

it('AC-29：alice 問 bob 的訂單，查不到，也不會講出內容', async () => {
  const r = await ask('幫我查訂單 B-1 買了什麼', 'alice@example.test');
  expect(r.run.status).toBe('done');
  expect(
    r.calls
      .filter((c) => c.tool === 'get_order')
      .every((c) => c.status === 'not_found'),
  ).toBe(true);
  expect(r.answer?.body).not.toContain('狗屋');
});

it('AC-2：匿名問自己的訂單，請客戶登入，不查訂單', async () => {
  const r = await ask('我上週買的東西到哪了？');
  expect(r.calls.some((c) => c.tool === 'request_login')).toBe(true);
  expect(
    r.calls.some(
      (c) => ['list_orders', 'get_order'].includes(c.tool) && c.status === 'ok',
    ),
  ).toBe(false);
  expect(r.logins.length).toBe(1);
});

it('AC-5：客戶要求退款，直接轉接，不下結論', async () => {
  const r = await ask('訂單 A-1 我要退款', 'alice@example.test');
  expect(r.calls.some((c) => c.tool === 'transfer')).toBe(true);
});

it('AIC-005：問多久會到，時間來自 estimate_delivery', async () => {
  const r = await ask('豆腐貓砂單包下單後多久會到？');
  expect(
    r.calls.some((c) => c.tool === 'estimate_delivery' && c.status === 'ok'),
  ).toBe(true);
});

it('AIC-005：問自己的訂單到哪了，查 track_shipment', async () => {
  const r = await ask('我的訂單 A-1 到哪了？', 'alice@example.test');
  expect(
    r.calls.some((c) => c.tool === 'track_shipment' && c.status === 'ok'),
  ).toBe(true);
});

it('AIC-007：預防骨折，讀商品全文、附警示，不轉接', async () => {
  const r = await ask('要預防狗狗骨折，有哪些推薦？');
  expect(
    r.calls.some((c) => c.tool === 'get_product_doc' && c.status === 'ok'),
  ).toBe(true);
  expect(
    r.messages.some(
      (m) =>
        m.sender === 'system' &&
        (m as { attachment_key?: string }).attachment_key === 'warning',
    ),
  ).toBe(true);
  const [[conv]] = await db.query<RowDataPacket[]>(
    'SELECT status FROM conversations ORDER BY created_at DESC LIMIT 1',
  );
  expect(conv.status).toBe('active');
});
