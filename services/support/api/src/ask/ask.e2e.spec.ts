import type { INestApplication } from '@nestjs/common';
import { loginCustomer } from '../../test/shop-sessions.js';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Socket } from 'socket.io-client';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { FakeLlm } from '../../test/fake-llm.js';
import { shopFixture } from '../../test/fixtures.js';
import { Client, startApp } from '../../test/http.js';
import { ack, connect, record, settle } from '../../test/socket.js';
import { seed } from '../db/seed.js';
import { AskService } from './ask.service.js';
import { RunTokenService } from '../tools/run-token.service.js';

let db: Pool;
let app: INestApplication;
let url: string;
let logs: () => string;
const llm = new FakeLlm();
const sockets: Socket[] = [];

beforeAll(async () => {
  db = testDb();
  ({ app, url, logs } = await startApp({ llm }));
});
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await truncate(db);
  await seed(db, testEnv);
  await shopFixture(db);
  llm.inputs.length = 0;
  llm.cancelled.length = 0;
  llm.toolResults.length = 0;
  llm.script = () => [{ text: '好的' }];
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await app.get(AskService).idle(); // 背景的回答做完才換下一個測試，不然會卡住清空資料表
});

async function customerChat(email?: string) {
  const c = new Client(url);
  if (email)
    await loginCustomer(c, email);
  else await c.post('/api/auth/customer/session');
  const conv = (await c.post('/api/conversations', { mode: 'ask' })).body;
  const socket = await connect(url, '/customer', c);
  sockets.push(socket);
  await ack(socket, 'join', { conversationId: conv.id });
  return { c, conv, socket };
}
const send = (socket: Socket, conversationId: string, body: string) =>
  ack(socket, 'send', { conversationId, body });
async function until<T>(get: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('等不到');
    await settle(20);
  }
}
const aiMessages = <T extends { sender: string }>(got: T[]) =>
  got.filter((m) => m.sender !== 'customer');
/** 思考中、串流、訊息依收到的順序記成一串，用來斷言氣泡出現和消失的時間點 */
function timeline(socket: Socket) {
  const got: string[] = [];
  socket.on('ask:thinking', (e: { active: boolean }) =>
    got.push(e.active ? 'thinking' : 'idle'),
  );
  socket.on('ask:delta', () => got.push('delta'));
  socket.on('message', (m: { sender: string }) => got.push(m.sender));
  return got;
}

describe('Ask：客戶', () => {
  it('匿名問庫存：串流回答，引用指向工具結果，紀錄寫進資料庫', async () => {
    llm.script = () => [
      { tool: 'get_stock', args: { sku: 'DCS-PRO-30' } },
      { text: '目前有貨[[ref:stock:DCS-PRO-30]]。' },
    ];
    const { conv, socket } = await customerChat();
    const deltas = record<{ text: string }>(socket, 'ask:delta');
    const refs = record<{ key: string; data: unknown }>(socket, 'ask:ref');
    const messages = record<{
      sender: string;
      body: string;
      refs_json?: unknown;
    }>(socket, 'message');
    await send(socket, conv.id, '益生菌有貨嗎');
    const ai = await until(() => aiMessages(messages)[0]);

    expect(deltas.map((d) => d.text).join('')).toBe('目前有貨。');
    expect(refs).toEqual([
      {
        runId: expect.any(String),
        key: 'stock:DCS-PRO-30',
        data: {
          sku: 'DCS-PRO-30',
          available: expect.any(Number),
          in_stock: true,
        },
      },
    ]);
    expect(ai).toMatchObject({
      sender: 'ai',
      body: '目前有貨。',
      refs_json: {
        'stock:DCS-PRO-30': expect.objectContaining({ in_stock: true }),
      },
    });
    const [runs] = await db.query<RowDataPacket[]>(
      'SELECT status, actor FROM ai_runs',
    );
    expect(runs).toEqual([{ status: 'done', actor: 'customer' }]);
    const [calls] = await db.query<RowDataPacket[]>(
      'SELECT tool, status FROM tool_calls',
    );
    expect(calls).toEqual([{ tool: 'get_stock', status: 'ok' }]);
  });

  it('引用指向沒查過的資料，從回答移除', async () => {
    llm.script = () => [{ text: '你的訂單已出貨[[ref:order:B-1]]' }];
    const { conv, socket } = await customerChat();
    const messages = record<{ sender: string; body: string }>(
      socket,
      'message',
    );
    await send(socket, conv.id, '我的訂單呢');
    expect((await until(() => aiMessages(messages)[0])).body).toBe(
      '你的訂單已出貨',
    );
  });

  it('匿名的工具清單沒有訂單工具；就算硬打也被拒', async () => {
    llm.script = () => [{ tool: 'list_orders' }, { text: '好' }];
    const { conv, socket } = await customerChat();
    const messages = record<{ sender: string }>(socket, 'message');
    await send(socket, conv.id, '查訂單');
    await until(() => aiMessages(messages)[0]);
    expect(llm.inputs[0].mcp?.allowedTools).not.toContain('list_orders');
    expect(llm.toolResults[0]).toMatchObject({
      isError: true,
      content: '{"error":"denied"}',
    });
  });

  it('AC-2：匿名問訂單時出現登入按鈕，同一段對話只出現一次', async () => {
    llm.script = () => [{ tool: 'request_login' }, { text: '請先登入' }];
    const { conv, socket } = await customerChat();
    const prompts = record(socket, 'ask:login');
    const messages = record<{ sender: string }>(socket, 'message');
    await send(socket, conv.id, '我的訂單到哪了');
    await until(() => aiMessages(messages).length === 1);
    await send(socket, conv.id, '我的訂單到哪了');
    await until(() => aiMessages(messages).length === 2);
    await settle();
    expect(prompts).toHaveLength(1);
  });

  it('AC-29：alice 問 bob 的訂單，工具回 not_found', async () => {
    llm.script = () => [
      { tool: 'get_order', args: { order_no: 'B-1', customer_id: 2 } },
      { text: '查不到' },
    ];
    const { conv, socket } = await customerChat('alice@example.test');
    const messages = record<{ sender: string }>(socket, 'message');
    await send(socket, conv.id, 'B-1 到哪了');
    await until(() => aiMessages(messages)[0]);
    expect(llm.inputs[0].mcp?.allowedTools).toContain('get_order');
    expect(llm.toolResults[0].content).toBe('{"error":"not_found"}');
  });

  it('脈絡只有這段對話：模型收到的是資料庫裡這段對話的紀錄', async () => {
    const a = await customerChat('alice@example.test');
    const b = await customerChat('bob@example.test');
    await send(a.socket, a.conv.id, 'alice 的祕密 CANARY-A');
    await send(b.socket, b.conv.id, 'bob 的問題');
    await until(() => llm.inputs.length === 2);
    const bobInput = llm.inputs.find((i) => i.conversationId === b.conv.id)!;
    expect(JSON.stringify(bobInput)).not.toContain('CANARY-A');
  });

  it('客戶的 Ask 看不到內部備註：模型拿到的脈絡只有客戶看得到的訊息', async () => {
    const { conv, socket } = await customerChat('alice@example.test');
    await db.query(
      "INSERT INTO messages (id, conversation_id, sender, visibility, body) VALUES (UUID(), ?, 'agent', 'internal', 'CANARY-內部備註')",
      [conv.id],
    );
    await send(socket, conv.id, '你好');
    await until(() => llm.inputs.length === 1);
    expect(JSON.stringify(llm.inputs[0].messages)).not.toContain(
      'CANARY-內部備註',
    );
  });

  it('同一段對話的新訊息取消前一個執行，token 也被撤銷', async () => {
    llm.script = (input) =>
      input.messages.length === 1 ? [{ hang: true }] : [{ text: '第二個' }];
    const { conv, socket } = await customerChat();
    const messages = record<{ sender: string; body: string }>(
      socket,
      'message',
    );
    await send(socket, conv.id, '第一則');
    await until(() => llm.inputs.length === 1);
    const firstToken = llm.inputs[0].mcp!.token;
    await send(socket, conv.id, '第二則');
    await until(() => aiMessages(messages)[0]);
    expect(llm.cancelled).toEqual([conv.id]);
    expect(app.get(RunTokenService).verify(firstToken)).toBeNull();
    expect(aiMessages(messages).map((m) => m.body)).toEqual(['第二個']);
  });

  it('模型出錯時不捏造答案，直接轉給真人（AIC-006）', async () => {
    llm.script = () => [{ error: 'unknown' }];
    const { conv, socket } = await customerChat();
    const messages = record<{ sender: string; body: string }>(
      socket,
      'message',
    );
    await send(socket, conv.id, '有貨嗎');
    expect((await until(() => aiMessages(messages)[0])).body).toBe(
      '目前沒有客服在線，我們會盡快回覆你。',
    );
    expect(aiMessages(messages).some((m) => m.sender === 'ai')).toBe(false);
  });

  it('AI 處理期間顯示思考中：路由之前開始，回答存好之後結束', async () => {
    llm.script = () => [{ text: '有貨' }];
    const { conv, socket } = await customerChat();
    const got = timeline(socket);
    await send(socket, conv.id, '益生菌有貨嗎');
    await until(() => got.includes('idle'));

    expect(got[0]).toBe('customer');
    expect(got[1]).toBe('thinking');
    expect(got.indexOf('thinking')).toBeLessThan(got.indexOf('delta'));
    expect(got.lastIndexOf('idle')).toBeGreaterThan(got.indexOf('ai'));
  });

  it('轉給真人時思考中也會結束', async () => {
    llm.script = () => [{ error: 'unknown' }];
    const { conv, socket } = await customerChat();
    const got = timeline(socket);
    await send(socket, conv.id, '有貨嗎');
    await until(() => got.includes('idle'));

    expect(got.filter((e) => e === 'thinking')).toHaveLength(1);
    expect(got.lastIndexOf('idle')).toBeGreaterThan(got.indexOf('system'));
  });

  it('新訊息取消前一個回答時，氣泡等新的回答做完才結束', async () => {
    llm.script = (input) =>
      input.messages.length === 1 ? [{ hang: true }] : [{ text: '第二個' }];
    const { conv, socket } = await customerChat();
    const got = timeline(socket);
    await send(socket, conv.id, '第一則');
    await until(() => llm.inputs.length === 1);
    await send(socket, conv.id, '第二則');
    await until(() => got.includes('ai'));
    await app.get(AskService).idle();
    await settle();

    expect(got.filter((e) => e === 'idle')).toHaveLength(1);
    expect(got.at(-1)).toBe('idle');
    expect(got.indexOf('idle')).toBeGreaterThan(got.indexOf('ai'));
  });

  it('被限流時不顯示思考中', async () => {
    const { conv, socket } = await customerChat();
    const thinking = record(socket, 'ask:thinking');
    for (let i = 0; i < 11; i++) await send(socket, conv.id, `第 ${i} 則`);
    await app.get(AskService).idle();
    await settle();
    expect(thinking.filter((e) => (e as { active: boolean }).active)).toHaveLength(10);
  });
});

describe('限流', () => {
  it('同一個 session 一分鐘第 11 則不呼叫模型，回固定文字；另一個 session 不受影響', async () => {
    const a = await customerChat();
    const messages = record<{ sender: string; body: string }>(
      a.socket,
      'message',
    );
    for (let i = 0; i < 11; i++) await send(a.socket, a.conv.id, `第 ${i} 則`);
    await until(() =>
      aiMessages(messages).some(
        (m) => m.body === '訊息有點多，請稍等一下再傳。',
      ),
    );
    await settle(200);
    expect(
      llm.inputs.filter((i) => i.conversationId === a.conv.id),
    ).toHaveLength(10);
    const b = await customerChat();
    await send(b.socket, b.conv.id, '你好');
    await until(() => llm.inputs.some((i) => i.conversationId === b.conv.id));
  });
});

describe('Ask：客服', () => {
  it('客服問 AI：回答只發到客服端，紀錄有客服是誰', async () => {
    const { c: alice, socket: aliceSocket } =
      await customerChat('alice@example.test');
    const conv = (await alice.post('/api/conversations', { mode: 'human' }))
      .body;
    await ack(aliceSocket, 'join', { conversationId: conv.id });
    const agent = new Client(url);
    await agent.post('/api/auth/staff/login', {
      email: 'support@example.test',
      password: '0204',
    });
    await agent.post(`/api/console/conversations/${conv.id}/assign`);
    const agentSocket = await connect(url, '/staff', agent);
    sockets.push(agentSocket);
    await ack(agentSocket, 'join', { conversationId: conv.id });
    const toAgent = record<{
      sender: string;
      visibility: string;
      body: string;
    }>(agentSocket, 'message');
    const toAlice = record(aliceSocket, 'message');
    const aliceDeltas = record(aliceSocket, 'ask:delta');
    const aliceThinking = record(aliceSocket, 'ask:thinking');
    const agentThinking = record(agentSocket, 'ask:thinking');

    llm.script = () => [
      { tool: 'get_order', args: { order_no: 'A-1' } },
      { text: 'A-1 已送達[[ref:order:A-1]]' },
    ];
    expect(
      await ack(agentSocket, 'ask', {
        conversationId: conv.id,
        question: 'A-1 狀態？',
      }),
    ).toEqual({ ok: true });
    const answer = await until(() => toAgent.find((m) => m.sender === 'ai'));
    expect(answer).toMatchObject({
      visibility: 'internal',
      body: 'A-1 已送達',
    });
    await settle();
    expect(toAlice).toEqual([]);
    expect(aliceDeltas).toEqual([]);
    expect(aliceThinking).toEqual([]);
    expect(agentThinking).toEqual([{ active: true }, { active: false }]);
    const [calls] = await db.query<RowDataPacket[]>(
      'SELECT tool, agent_id FROM tool_calls',
    );
    expect(calls).toEqual([
      { tool: 'get_order', agent_id: expect.any(Number) },
    ]);
    expect(llm.inputs[0].mcp?.allowedTools).toContain('find_customer');
  });

  it('沒被指派的客服不能問這段對話', async () => {
    const { conv } = await customerChat('alice@example.test');
    const agent = new Client(url);
    await agent.post('/api/auth/staff/login', {
      email: 'support@example.test',
      password: '0204',
    });
    const s = await connect(url, '/staff', agent);
    sockets.push(s);
    expect(
      await ack(s, 'ask', { conversationId: conv.id, question: '?' }),
    ).toEqual({ ok: false, error: 'forbidden' });
  });
});

describe('log', () => {
  it('回答內容不進 log', async () => {
    llm.script = () => [{ text: 'CANARY-回答內容' }];
    const { conv, socket } = await customerChat();
    const messages = record<{ sender: string }>(socket, 'message');
    await send(socket, conv.id, 'CANARY-問題內容');
    await until(() => aiMessages(messages)[0]);
    expect(logs()).not.toMatch(/CANARY-/);
  });
});
