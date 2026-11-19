import type { INestApplication } from '@nestjs/common';
import { loginCustomer } from '../../test/shop-sessions.js';
import type { Pool } from 'mysql2/promise';
import type { Socket } from 'socket.io-client';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { FakeLlm } from '../../test/fake-llm.js';
import { shopFixture } from '../../test/fixtures.js';
import { Client, startApp } from '../../test/http.js';
import { ack, connect } from '../../test/socket.js';
import { AskService } from '../ask/ask.service.js';
import { seed } from '../db/seed.js';

let db: Pool;
let app: INestApplication;
let url: string;
const llm = new FakeLlm();
const sockets: Socket[] = [];
beforeAll(async () => {
  db = testDb();
  ({ app, url } = await startApp({ llm }));
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

describe('追蹤面板', () => {
  it('被指派的客服看得到每次 AI 執行的判斷、工具、參數、結果和耗時', async () => {
    const alice = new Client(url);
    await loginCustomer(alice, 'alice@example.test');
    const conv = (await alice.post('/api/conversations', { mode: 'human' }))
      .body;
    const agent = new Client(url);
    await agent.post('/api/auth/staff/login', {
      email: 'support@example.test',
      password: '0204',
    });
    await agent.post(`/api/console/conversations/${conv.id}/assign`);
    const s = await connect(url, '/staff', agent);
    sockets.push(s);
    await ack(s, 'join', { conversationId: conv.id });
    llm.script = () => [
      { tool: 'get_order', args: { order_no: 'A-1' } },
      { text: '已送達[[ref:order:A-1]]' },
    ];
    await ack(s, 'ask', { conversationId: conv.id, question: 'A-1 呢' });
    await app.get(AskService).idle();

    const trace = (
      await agent.get(`/api/console/conversations/${conv.id}/trace`)
    ).body;
    expect(trace.runs).toEqual([
      expect.objectContaining({
        kind: 'ask',
        actor: 'agent',
        status: 'done',
        total_ms: expect.any(Number),
        tool_calls: [
          expect.objectContaining({
            tool: 'get_order',
            status: 'ok',
            args_json: { order_no: 'A-1' },
            result_json: expect.objectContaining({ ref: 'order:A-1' }),
          }),
        ],
      }),
    ]);
    expect(trace.proposals).toEqual([]);
  });

  it('沒被指派的客服查不到別段對話的追蹤', async () => {
    const alice = new Client(url);
    await loginCustomer(alice, 'alice@example.test');
    const conv = (await alice.post('/api/conversations', { mode: 'human' }))
      .body;
    const agent = new Client(url);
    await agent.post('/api/auth/staff/login', {
      email: 'support@example.test',
      password: '0204',
    });
    expect(
      (await agent.get(`/api/console/conversations/${conv.id}/trace`)).status,
    ).toBe(403);
    expect(
      (await alice.get(`/api/console/conversations/${conv.id}/trace`)).status,
    ).toBe(401);
  });
});
