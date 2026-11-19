import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ProposalService } from '../src/proposals/proposal.service.js';
import { loginCustomer } from './shop-sessions.js';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Socket } from 'socket.io-client';
import { parse } from 'yaml';
import { AskService } from '../src/ask/ask.service.js';
import { seedDemoOrders } from './demo-orders.js';
import { fakeShop } from './fake-shop.js';
import { seed } from '../src/db/seed.js';
import {
  evaluate,
  type Expect,
  type Observation,
} from '../src/evals/assertions.js';
import { JoinService } from '../src/join/join.service.js';
import { testDb, testEnv, truncate } from './db.js';
import { Client, startApp } from './http.js';
import { realRunner } from './real-helpers.js';
import { ack, connect, settle } from './socket.js';

// §8 回歸測試：真的模型跑完整條路。花額度，手動跑：scripts/support.sh llm evals
// 預設每個案例跑 1 次，tags 有 security 的跑 3 次；EVAL_RUNS 可以改。
// join 模式：前面幾則先在 Join 關著時送出，最後一則前才打開，閘門只判斷最後一則
if (process.env.SUPPORT_CONTAINER !== '1') throw new Error('只能在容器裡跑');

interface Case {
  id: string;
  mode: 'ask-customer' | 'ask-agent' | 'join';
  who: 'alice' | 'bob' | 'anonymous';
  turns: (string | { agent: string })[]; // 字串是客戶（ask-agent 是客服問 AI）；join 模式可以有客服的話
  tags?: string[];
  setup?: { logistics_down?: 'on' };
  approve?: boolean;
  expect: Expect;
}
const CASES = parse(
  readFileSync(join(process.cwd(), 'test/evals/cases.yaml'), 'utf8'),
) as Case[];
const RUNS = Number(process.env.EVAL_RUNS ?? 1);
const JOIN_WAIT_MS = 500;
const text = (t: Case['turns'][number]) => (typeof t === 'string' ? t : t.agent);

let db: Pool;
let app: INestApplication;
let url: string;
const sockets: Socket[] = [];
const report: {
  id: string;
  run: number;
  failures: string[];
  tools: string[];
  gate: string[];
  proposals: string[]; // 狀態/shop 擋下的原因
  refunds: string[];
}[] = [];

beforeAll(async () => {
  db = testDb();
  ({ app, url } = await startApp({
    llm: realRunner({ maxConcurrent: 3 }),
    env: { SUPPORT_JOIN_DEBOUNCE_MS: String(JOIN_WAIT_MS) },
  }));
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await app.close();
  await db.end();
  const dir = join(process.cwd(), 'support-eval-runs');
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(file, JSON.stringify(report, null, 2));
  const failed = report.filter((r) => r.failures.length);
  console.log(
    `\n  評測：${report.length - failed.length}/${report.length} 通過，報告在 ${file}`,
  );
});

async function login(who: Case['who']) {
  const c = new Client(url);
  if (who === 'anonymous') await c.post('/api/auth/customer/session');
  else
    await loginCustomer(c, `${who}@example.test`);
  return c;
}
const settleAll = async () => {
  await app.get(JoinService).idle();
  await app.get(AskService).idle();
  await app.get(ProposalService).idle(); // 核准後等金流結果（AIC-016）
};

async function runCase(c: Case): Promise<{ obs: Observation; convId: string }> {
  await truncate(db);
  await seed(db, testEnv);
  fakeShop.reset();
  await seedDemoOrders(fakeShop);
  if (c.setup?.logistics_down) fakeShop.logisticsDown = true; // partners 的物流故障（AIC-017）

  const customer = await login(c.who);
  let convId: string;
  if (c.mode === 'ask-customer') {
    convId = (await customer.post('/api/conversations', { mode: 'ask' })).body
      .id;
    const s = await connect(url, '/customer', customer);
    sockets.push(s);
    await ack(s, 'join', { conversationId: convId });
    for (const t of c.turns) {
      await ack(s, 'send', { conversationId: convId, body: text(t) });
      await settleAll();
    }
  } else if (c.mode === 'join') {
    convId = (await customer.post('/api/conversations', { mode: 'human' })).body
      .id;
    const agent = new Client(url);
    await agent.post('/api/auth/staff/login', {
      email: 'support@example.test',
      password: '0204',
    });
    await agent.post(`/api/console/conversations/${convId}/assign`);
    const cs = await connect(url, '/customer', customer);
    const as = await connect(url, '/staff', agent);
    sockets.push(cs, as);
    await ack(cs, 'join', { conversationId: convId });
    await ack(as, 'join', { conversationId: convId });
    for (const [i, t] of c.turns.entries()) {
      if (i === c.turns.length - 1)
        await ack(as, 'join:toggle', { conversationId: convId, on: true });
      await ack(typeof t === 'string' ? cs : as, 'send', {
        conversationId: convId,
        body: text(t),
      });
    }
    await settle(JOIN_WAIT_MS + 300); // 客戶的訊息要等停止輸入才判斷
    await settleAll();
  } else {
    convId = (await customer.post('/api/conversations', { mode: 'human' })).body
      .id;
    const agent = new Client(url);
    await agent.post('/api/auth/staff/login', {
      email: 'support@example.test',
      password: '0204',
    });
    await agent.post(`/api/console/conversations/${convId}/assign`);
    const s = await connect(url, '/staff', agent);
    sockets.push(s);
    await ack(s, 'join', { conversationId: convId });
    for (const t of c.turns) {
      await ack(s, 'ask', { conversationId: convId, question: text(t) });
      await settleAll();
    }
    if (c.approve) {
      const [ps] = await db.query<RowDataPacket[]>(
        "SELECT id FROM proposals WHERE conversation_id = ? AND status = 'pending'",
        [convId],
      );
      for (const p of ps)
        await agent.post(`/api/console/proposals/${p.id}/approve`);
      await app.get(ProposalService).idle(); // 等金流結果（AIC-016）
    }
  }

  const q = async (sql: string) =>
    (await db.query<RowDataPacket[]>(sql, [convId]))[0];
  const tools = (await q(
    'SELECT t.tool, t.status, t.args_json AS args FROM tool_calls t JOIN ai_runs r ON r.id = t.run_id WHERE r.conversation_id = ? ORDER BY t.created_at',
  )) as Observation['tools'];
  const messages = (await q(
    'SELECT sender, body, attachment_key, visibility, refs_json FROM messages WHERE conversation_id = ? ORDER BY seq',
  )) as (Observation['messages'][number] & {
    refs_json: Record<string, unknown> | null;
  })[];
  const [h] = await q(
    'SELECT queue, flagged_attack FROM handoffs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1',
  );
  const proposals = (await q(
    "SELECT status, JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.code')) AS code FROM proposals WHERE conversation_id = ?",
  )) as Observation['proposals'];
  const gate = await q(
    "SELECT JSON_UNQUOTE(JSON_EXTRACT(decision_json, '$.action')) AS action FROM ai_runs WHERE conversation_id = ? AND kind = 'gate' ORDER BY created_at",
  );
  const refunds = fakeShop.allRefunds();
  return {
    convId,
    obs: {
      tools,
      refs: messages.flatMap((m) => Object.keys(m.refs_json ?? {})),
      messages,
      handoff: h
        ? { queue: h.queue, flagged_attack: h.flagged_attack === 1 }
        : null,
      proposals,
      gate: gate.map((g) => g.action ?? '失敗'),
      refunds: refunds as Observation['refunds'],
    },
  };
}

for (const c of CASES) {
  const runs = c.tags?.includes('security') ? Math.max(RUNS, 3) : RUNS;
  for (let run = 1; run <= runs; run++) {
    it(`${c.id}（第 ${run} 次）`, async () => {
      const { obs } = await runCase(c);
      const failures = evaluate(obs, c.expect);
      report.push({
        id: c.id,
        run,
        failures,
        tools: obs.tools.map((t) => `${t.tool}:${t.status}`),
        gate: obs.gate,
        proposals: obs.proposals.map(
          (p) => `${p.status}${p.code ? `/${p.code}` : ''}`,
        ),
        refunds: obs.refunds.map((r) => `${r.order_no}:${r.amount}`),
      });
      console.log(
        `  ${failures.length ? '❌' : '✅'} ${c.id}#${run}${obs.gate.length ? ` gate=${obs.gate.join(',')}` : ''} tools=${obs.tools.map((t) => t.tool).join(',') || '-'} handoff=${obs.handoff ? `${obs.handoff.queue}${obs.handoff.flagged_attack ? '!' : ''}` : '-'} proposals=${obs.proposals.map((p) => `${p.status}${p.code ? `/${p.code}` : ''}`).join(',') || '-'} refunds=${obs.refunds.map((r) => `${r.order_no}:${r.amount}`).join(',') || '-'}${failures.length ? ` → ${failures.join('；')}` : ''}`,
      );
      expect(failures).toEqual([]);
    });
  }
}
