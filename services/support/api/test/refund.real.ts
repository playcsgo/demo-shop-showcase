import type { INestApplication } from '@nestjs/common';
import { ProposalService } from '../src/proposals/proposal.service.js';
import { loginCustomer } from './shop-sessions.js';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Socket } from 'socket.io-client';
import { AskService } from '../src/ask/ask.service.js';
import { seed } from '../src/db/seed.js';
import { testDb, testEnv, truncate } from './db.js';
import { fakeShop, shopFixture } from './fixtures.js';
import { Client, startApp } from './http.js';
import { realRunner } from './real-helpers.js';
import { ack, connect } from './socket.js';

// AIC-009：真的模型提出退款提案，客服核准。花額度，手動跑：scripts/support.sh llm refund
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
let aliceId: number;
beforeEach(async () => {
  await truncate(db);
  await seed(db, testEnv);
  ({ alice: aliceId } = await shopFixture(db));
  fakeShop.createOrder(aliceId, [{ sku: 'DCS-KIB-1500', qty: 1 }], {
    orderNo: 'OLD-1',
    status: 'delivered',
    createdAt: new Date(Date.now() - 30 * 86_400_000),
  });
});

async function agentAsks(question: string) {
  const alice = new Client(url);
  await loginCustomer(alice, 'alice@example.test');
  const conv = (await alice.post('/api/conversations', { mode: 'human' })).body;
  const agent = new Client(url);
  await agent.post('/api/auth/staff/login', {
    email: 'support@example.test',
    password: '0204',
  });
  await agent.post(`/api/console/conversations/${conv.id}/assign`);
  const s = await connect(url, '/staff', agent);
  sockets.push(s);
  await ack(s, 'join', { conversationId: conv.id });
  await ack(s, 'ask', { conversationId: conv.id, question });
  await app.get(AskService).idle();
  const [rows] = await db.query<RowDataPacket[]>(
    'SELECT id, status, preview_json, refs_json, judgment FROM proposals WHERE conversation_id = ?',
    [conv.id],
  );
  const [calls] = await db.query<RowDataPacket[]>(
    'SELECT t.tool FROM tool_calls t JOIN ai_runs r ON r.id = t.run_id WHERE r.conversation_id = ?',
    [conv.id],
  );
  const [replies] = await db.query<RowDataPacket[]>(
    "SELECT refs_json FROM messages WHERE conversation_id = ? AND sender = 'ai'",
    [conv.id],
  );
  // AI 回答裡引用過的資料（SOP 條目、訂單…）
  const cited = replies.flatMap((m) => Object.keys(m.refs_json ?? {}));
  console.log(
    `  [${question}] cited=${cited.join(',')} tools=${calls.map((c) => c.tool).join(',')} proposals=${rows.map((r) => `${r.status}/${JSON.stringify(r.preview_json)}`).join(';')}`,
  );
  return {
    agent,
    cited,
    proposals: rows.length,
    proposal: rows[0] as
      | {
          id: string;
          preview_json: { amount: number; eligible: boolean };
          refs_json: string[] | null;
        }
      | undefined,
  };
}

it('7 天內：提出提案並引用 SOP，核准後真的退款；四個地方的金額一致', async () => {
  const { agent, proposal } = await agentAsks(
    '客戶說訂單 A-1 的鴨肉罐想退 2 罐，還沒開，請判斷能不能退，可以的話提出退款提案',
  );
  expect(proposal?.refs_json).toContain('sop:refund#S2');
  expect(proposal?.preview_json).toMatchObject({ eligible: true, amount: 96 });
  const r = await agent.post(`/api/console/proposals/${proposal!.id}/approve`);
  expect(r.body).toMatchObject({ status: 'refund_pending', amount: 96 });
  await app.get(ProposalService).idle(); // 等金流結果（AIC-016）
  // 提案卡片、核准回應、退款紀錄、提案的執行結果：同一筆錢只能有一個數字
  const [[row]] = await db.query<RowDataPacket[]>(
    'SELECT result_json FROM proposals WHERE id = ?',
    [proposal!.id],
  );
  const [refund] = (await fakeShop.refunds(aliceId, 'A-1', 'anonymous'))!;
  expect(refund.amount).toBe(96);
  expect(refund.items.reduce((n, i) => n + i.qty, 0)).toBe(2);
  expect(row.result_json).toMatchObject({ status: 'executed', amount: 96 });
});

it('已開封（§E2）：不提案，判斷引用 §E2', async () => {
  const { cited, proposals } = await agentAsks(
    '客戶說訂單 A-1 的鴨肉罐想退 2 罐，已經開封吃了一半，請判斷能不能退，可以的話提出退款提案',
  );
  expect(proposals).toBe(0); // shop 不知道有沒有開封：提了就會被核准
  expect(cited).toContain('sop:refund#E2');
});

it('超過期限：判斷引用 §S2；就算提出提案，核准時也會被系統擋下，錢沒有動', async () => {
  const { agent, proposal, cited } = await agentAsks(
    '客戶要退訂單 OLD-1 的無穀乾糧 1 包，請判斷，可以的話提出退款提案',
  );
  if (proposal) {
    const r = await agent.post(`/api/console/proposals/${proposal.id}/approve`);
    expect(r.body).toMatchObject({
      status: 'rejected_by_shop',
      code: 'refund_window_expired',
    });
  }
  expect(fakeShop.allRefunds().filter((r) => r.order_no === 'OLD-1')).toEqual([]);
  // 不能只靠「沒提案」就算過：判斷要有依據。引用整份退款 SOP 也算，裡面就有 §S2
  expect(cited).toEqual(
    expect.arrayContaining([expect.stringMatching(/^sop:refund(#S2)?$/)]),
  );
});
