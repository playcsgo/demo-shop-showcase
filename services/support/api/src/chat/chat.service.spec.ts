import type { Pool, RowDataPacket } from 'mysql2/promise';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { SessionService } from '../auth/session.service.js';
import { seed } from '../db/seed.js';
import { ChatService } from './chat.service.js';

let db: Pool;
let chat: ChatService;
let sessions: SessionService;
const alice = { id: 1, name: 'Alice' };
const bob = { id: 2, name: 'Bob' };
const agent = { id: 1, name: '客服小美', role: 'support_agent' as const };

beforeAll(() => {
  db = testDb();
  sessions = new SessionService(db);
  chat = new ChatService(db);
});
afterAll(() => db.end());
beforeEach(async () => {
  await truncate(db);
  await seed(db, testEnv);
});

const staffSession = async (staffId = agent.id) => {
  const { hash } = await sessions.create('staff', staffId);
  return { hash, kind: 'staff' as const, subjectId: staffId };
};

const customerSession = async (customerId: number | null) => {
  const { hash } = await sessions.create('customer', customerId);
  return { hash, kind: 'customer' as const, subjectId: customerId };
};

describe('ChatService', () => {
  it('AC-1：human 對話進客服佇列，ask 對話不進佇列', async () => {
    const s = await customerSession(alice.id);
    const human = await chat.start(s, alice, 'human');
    const ask = await chat.start(s, alice, 'ask');
    expect(human).toMatchObject({
      mode: 'human',
      status: 'queued',
      queue: 'cs',
      customer_id: alice.id,
    });
    expect(ask).toMatchObject({ mode: 'ask', status: 'active', queue: null });
    expect((await chat.queue('support_agent')).map((c) => c.id)).toEqual([
      human.id,
    ]);
  });

  it('AC-25：訊息照送出順序讀回，時間由伺服器決定', async () => {
    const s = await customerSession(alice.id);
    const conv = await chat.start(s, alice, 'human');
    for (let i = 0; i < 20; i++)
      await chat.postCustomer(conv.id, s, alice, `第 ${i} 則`);
    const history = await chat.history(conv.id, 'customer');
    expect(history.map((m) => m.body)).toEqual(
      Array.from({ length: 20 }, (_, i) => `第 ${i} 則`),
    );
    expect(
      Math.abs(new Date(history[0].created_at).getTime() - Date.now()),
    ).toBeLessThan(10_000);
  });

  it('只有開對話的 session 或同一位登入客戶看得到', async () => {
    const anon = await customerSession(null);
    const otherAnon = await customerSession(null);
    const aliceSession = await customerSession(alice.id);
    const aliceElsewhere = await customerSession(alice.id);
    const bobSession = await customerSession(bob.id);
    const anonConv = await chat.start(anon, null, 'ask');
    const aliceConv = await chat.start(aliceSession, alice, 'ask');

    expect(await chat.customerCanAccess(anonConv.id, anon, null)).toBe(true);
    expect(await chat.customerCanAccess(anonConv.id, otherAnon, null)).toBe(
      false,
    );
    expect(await chat.customerCanAccess(anonConv.id, aliceSession, alice)).toBe(
      false,
    ); // 登入後是新對話
    expect(
      await chat.customerCanAccess(aliceConv.id, aliceElsewhere, alice),
    ).toBe(true);
    expect(await chat.customerCanAccess(aliceConv.id, bobSession, bob)).toBe(
      false,
    );
    expect(await chat.customerCanAccess('not-a-uuid', anon, null)).toBe(false);
  });

  it('AC-26：內部訊息客戶讀不到，客服讀得到', async () => {
    const s = await customerSession(alice.id);
    const conv = await chat.start(s, alice, 'human');
    expect(await chat.assign(conv.id, agent)).toBe(true);
    await chat.postAgent(
      conv.id,
      await staffSession(),
      agent,
      '公開回覆',
      'public',
    );
    await chat.postAgent(
      conv.id,
      await staffSession(),
      agent,
      '內部備註',
      'internal',
    );
    expect(
      (await chat.history(conv.id, 'customer')).map((m) => m.body),
    ).toEqual(['公開回覆']);
    expect((await chat.history(conv.id, 'staff')).map((m) => m.body)).toEqual([
      '公開回覆',
      '內部備註',
    ]);
  });

  it.each(['customer', 'staff'] as const)(
    '%s 送出的同時登出：等登出完成後被拒絕，訊息沒有寫入',
    async (who) => {
      const s = await customerSession(alice.id);
      const conv = await chat.start(s, alice, 'human');
      await chat.assign(conv.id, agent);
      const staff = await staffSession();
      const target = who === 'customer' ? s : staff;

      // 登出的交易刪掉 session，還沒提交
      const conn = await db.getConnection();
      await conn.beginTransaction();
      await conn.query('DELETE FROM sessions WHERE token_hash = ?', [
        target.hash,
      ]);
      const sending =
        who === 'customer'
          ? chat.postCustomer(conv.id, s, alice, '登出瞬間')
          : chat.postAgent(conv.id, staff, agent, '登出瞬間', 'public');
      const early = await Promise.race([
        sending.then(
          () => 'finished',
          () => 'finished',
        ),
        new Promise((r) => setTimeout(() => r('waiting'), 200)),
      ]);
      await conn.commit();
      conn.release();

      expect(early).toBe('waiting'); // 送出要等登出完成，不能搶在前面寫入
      await expect(sending).rejects.toThrow('forbidden');
      const [rows] = await db.query<RowDataPacket[]>('SELECT id FROM messages');
      expect(rows).toEqual([]);
    },
  );

  it('session 已經失效時送不出去', async () => {
    const s = await customerSession(alice.id);
    const conv = await chat.start(s, alice, 'human');
    await sessions.revoke(s.hash);
    await expect(chat.postCustomer(conv.id, s, alice, '你好')).rejects.toThrow(
      'forbidden',
    );
  });

  it('客服沒被指派就不能送訊息', async () => {
    const s = await customerSession(alice.id);
    const conv = await chat.start(s, alice, 'human');
    await expect(
      chat.postAgent(conv.id, await staffSession(), agent, '你好', 'public'),
    ).rejects.toThrow('not_assigned');
  });

  it('兩位客服同時接手，只有一位成功', async () => {
    await db.query(
      "INSERT INTO staff (email, name, role, password_hash) VALUES ('s2@example.test', '客服二號', 'support_agent', 'x')",
    );
    const [[second]] = await db.query<RowDataPacket[]>(
      "SELECT id FROM staff WHERE email = 's2@example.test'",
    );
    const s = await customerSession(alice.id);
    const conv = await chat.start(s, alice, 'human');
    const results = await Promise.all([
      chat.assign(conv.id, agent),
      chat.assign(conv.id, { ...agent, id: second.id }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('客服改成獸醫後，不能再存取原本客服佇列的對話', async () => {
    const s = await customerSession(alice.id);
    const conv = await chat.start(s, alice, 'human');
    await chat.assign(conv.id, agent);
    expect(await chat.staffCanAccess(conv.id, { ...agent, role: 'vet' })).toBe(
      false,
    );
  });

  it('紀錄帶遞增的序號', async () => {
    const s = await customerSession(alice.id);
    const conv = await chat.start(s, alice, 'human');
    await chat.postCustomer(conv.id, s, alice, '一');
    await chat.postCustomer(conv.id, s, alice, '二');
    const [a, b] = await chat.history(conv.id, 'customer');
    expect(a.seq).toBeLessThan(b.seq);
  });

  it('獸醫接不了客服佇列的對話', async () => {
    const s = await customerSession(alice.id);
    const conv = await chat.start(s, alice, 'human');
    expect(
      await chat.assign(conv.id, { id: 2, name: '獸醫阿哲', role: 'vet' }),
    ).toBe(false);
    expect(await chat.queue('vet')).toEqual([]);
  });

  it('佇列摘要不含訊息內容', async () => {
    const s = await customerSession(alice.id);
    const conv = await chat.start(s, alice, 'human');
    await chat.postCustomer(conv.id, s, alice, '我的地址是秘密');
    expect(JSON.stringify(await chat.queue('support_agent'))).not.toContain(
      '秘密',
    );
  });

  it.each(['', '   ', 'x'.repeat(2001)])(
    '訊息內容不合法（%j）會被拒',
    async (body) => {
      const s = await customerSession(alice.id);
      const conv = await chat.start(s, alice, 'human');
      await expect(chat.postCustomer(conv.id, s, alice, body)).rejects.toThrow(
        'invalid_body',
      );
    },
  );

  it('客戶訊息只存客戶自己的那則；AI 回答由 AskService 另外寫', async () => {
    const s = await customerSession(null);
    const conv = await chat.start(s, null, 'ask');
    const posted = await chat.postCustomer(conv.id, s, null, '有貨嗎');
    expect(posted.map((m) => [m.sender, m.body])).toEqual([
      ['customer', '有貨嗎'],
    ]);
  });

  it('登入按鈕的標記只會成功一次', async () => {
    const s = await customerSession(null);
    const conv = await chat.start(s, null, 'ask');
    expect(
      await Promise.all([
        chat.markLoginPrompted(conv.id),
        chat.markLoginPrompted(conv.id),
      ]),
    ).toEqual(expect.arrayContaining([true, false]));
  });

  it('AI 回答連同引用的資料一起存', async () => {
    const s = await customerSession(null);
    const conv = await chat.start(s, null, 'ask');
    await chat.postAi(conv.id, '有貨', 'public', {
      'stock:X': { in_stock: true },
    });
    const [m] = await chat.history(conv.id, 'customer');
    expect(m).toMatchObject({
      sender: 'ai',
      body: '有貨',
      refs_json: { 'stock:X': { in_stock: true } },
    });
  });
});
