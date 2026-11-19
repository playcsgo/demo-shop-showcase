import type { INestApplication } from '@nestjs/common';
import { loginCustomer, logoutShop } from '../../test/shop-sessions.js';
import { Logger } from 'nestjs-pino';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Socket } from 'socket.io-client';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { Client, startApp } from '../../test/http.js';
import {
  ack,
  connect,
  disconnected,
  record,
  settle,
} from '../../test/socket.js';
import { AskService } from '../ask/ask.service.js';
import { seed } from '../db/seed.js';

let db: Pool;
let app: INestApplication;
let url: string;
let logs: () => string;
let waitForLog: (needle: string) => Promise<void>;
const sockets: Socket[] = [];

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
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await app.get(AskService).idle(); // 背景的回答做完才換下一個測試，不然會卡住清空資料表
});

const open = async (...args: Parameters<typeof connect>) => {
  const s = await connect(...args);
  sockets.push(s);
  return s;
};
async function customer(email?: string) {
  const c = new Client(url);
  if (email)
    await loginCustomer(c, email);
  else await c.post('/api/auth/customer/session');
  return c;
}
async function staff(email = 'support@example.test') {
  const c = new Client(url);
  await c.post('/api/auth/staff/login', { email, password: '0204' });
  return c;
}
const startConversation = async (
  c: Client,
  mode: 'ask' | 'human',
  extra = {},
) => (await c.post('/api/conversations', { mode, ...extra })).body;

describe('開對話', () => {
  it('customer_id 只來自 session，請求裡帶的值會被忽略', async () => {
    const alice = await customer('alice@example.test');
    const conv = await startConversation(alice, 'human', {
      customer_id: 999,
      status: 'assigned',
    });
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT status, customer_id FROM conversations',
    );
    expect(rows).toEqual([{ status: 'queued', customer_id: 1 }]); // 商店的 alice
    expect(conv.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('沒有 session 不能開對話', async () => {
    expect(
      (await new Client(url).post('/api/conversations', { mode: 'ask' }))
        .status,
    ).toBe(401);
  });

  it('mode 不合法回 400', async () => {
    expect(
      (await (await customer()).post('/api/conversations', { mode: 'admin' }))
        .status,
    ).toBe(400);
  });
});

describe('連線', () => {
  it('沒有 cookie、Origin 不對、已登出、過期都連不上', async () => {
    const alice = await customer('alice@example.test');
    await expect(connect(url, '/customer')).rejects.toThrow();
    await expect(
      connect(url, '/customer', alice, 'https://evil.example'),
    ).rejects.toThrow();
    const expired = await customer('bob@example.test');
    await db.query(
      'UPDATE sessions SET expires_at = NOW(3) - INTERVAL 1 SECOND WHERE kind = ? AND subject_id = ?',
      ['customer', 2], // 商店的 bob
    );
    await expect(connect(url, '/customer', expired)).rejects.toThrow();
    const cookie = alice.cookies.get('support_customer')!;
    await alice.post('/api/auth/customer/logout');
    alice.cookies.set('support_customer', cookie);
    await expect(connect(url, '/customer', alice)).rejects.toThrow();
  });

  it('客戶的 cookie 連不上員工的 namespace', async () => {
    const alice = await customer('alice@example.test');
    await expect(connect(url, '/staff', alice)).rejects.toThrow();
  });
});

describe('房間', () => {
  it('客戶 A 加入不了 B 的對話，匿名也加入不了別人的匿名對話', async () => {
    const alice = await customer('alice@example.test');
    const bob = await customer('bob@example.test');
    const anon1 = await customer();
    const anon2 = await customer();
    const bobConv = await startConversation(bob, 'human');
    const anonConv = await startConversation(anon1, 'ask');
    const aliceSocket = await open(url, '/customer', alice);
    const anon2Socket = await open(url, '/customer', anon2);
    expect(
      await ack(aliceSocket, 'join', { conversationId: bobConv.id }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(
      await ack(anon2Socket, 'join', { conversationId: anonConv.id }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(
      await ack(aliceSocket, 'send', {
        conversationId: bobConv.id,
        body: '偷看',
      }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(
      (await alice.get(`/api/conversations/${bobConv.id}/messages`)).status,
    ).toBe(403);
  });

  it('客服沒被指派時看得到佇列，但加入不了也送不出訊息；接手後就可以', async () => {
    const alice = await customer('alice@example.test');
    const agent = await staff();
    const conv = await startConversation(alice, 'human');
    const agentSocket = await open(url, '/staff', agent);
    expect(
      (await agent.get('/api/console/queue')).body.map(
        (c: { id: string }) => c.id,
      ),
    ).toEqual([conv.id]);
    expect(await ack(agentSocket, 'join', { conversationId: conv.id })).toEqual(
      { ok: false, error: 'forbidden' },
    );
    expect(
      await ack(agentSocket, 'send', { conversationId: conv.id, body: '你好' }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(
      (await agent.get(`/api/console/conversations/${conv.id}/messages`))
        .status,
    ).toBe(403);
    expect(
      (await agent.post(`/api/console/conversations/${conv.id}/assign`)).status,
    ).toBe(200);
    expect(await ack(agentSocket, 'join', { conversationId: conv.id })).toEqual(
      { ok: true },
    );
  });

  it('雙方即時對話；內部訊息客戶的連線收不到', async () => {
    const alice = await customer('alice@example.test');
    const agent = await staff();
    const conv = await startConversation(alice, 'human');
    await agent.post(`/api/console/conversations/${conv.id}/assign`);
    const aliceSocket = await open(url, '/customer', alice);
    const agentSocket = await open(url, '/staff', agent);
    const toAlice = record<{ body: string }>(aliceSocket, 'message');
    const toAgent = record<{ body: string }>(agentSocket, 'message');
    await ack(aliceSocket, 'join', { conversationId: conv.id });
    await ack(agentSocket, 'join', { conversationId: conv.id });

    await ack(aliceSocket, 'send', {
      conversationId: conv.id,
      body: '東西還沒到',
    });
    await ack(agentSocket, 'send', {
      conversationId: conv.id,
      body: '我幫你查',
    });
    await ack(agentSocket, 'note', {
      conversationId: conv.id,
      body: '內部：客戶語氣急',
    });
    await settle();

    expect(toAlice.map((m) => m.body)).toEqual(['東西還沒到', '我幫你查']);
    expect(toAgent.map((m) => m.body)).toEqual([
      '東西還沒到',
      '我幫你查',
      '內部：客戶語氣急',
    ]);
    expect(
      (await alice.get(`/api/conversations/${conv.id}/messages`)).body.map(
        (m: { body: string }) => m.body,
      ),
    ).toEqual(['東西還沒到', '我幫你查']);
  });

  it('兩段對話同時各收發 100 則，沒有任何訊息跑到別段', async () => {
    const pairs = await Promise.all(
      ['alice@example.test', 'bob@example.test'].map(async (email) => {
        const c = await customer(email);
        // 真人模式：這裡測的是房間隔離，不要讓每則訊息都觸發 AI
        const conv = await startConversation(c, 'human');
        const socket = await open(url, '/customer', c);
        await ack(socket, 'join', { conversationId: conv.id });
        return {
          email,
          conv,
          socket,
          got: record<{
            conversation_id: string;
            body: string;
            sender: string;
          }>(socket, 'message'),
        };
      }),
    );
    await Promise.all(
      pairs.map((p) =>
        Promise.all(
          Array.from({ length: 100 }, (_, i) =>
            ack(p.socket, 'send', {
              conversationId: p.conv.id,
              body: `${p.email} #${i}`,
            }),
          ),
        ),
      ),
    );
    await settle(300);
    for (const p of pairs) {
      expect(p.got.every((m) => m.conversation_id === p.conv.id)).toBe(true);
      expect(p.got.filter((m) => m.body.startsWith(p.email))).toHaveLength(100);
      // 其他的只能是這段對話的 AI 回答或系統訊息（例如限流提示），不會是別人的訊息
      expect(
        p.got
          .filter((m) => !m.body.startsWith(p.email))
          .every((m) => m.sender === 'ai' || m.sender === 'system'),
      ).toBe(true);
    }
  });

  it('登出後連線被斷開，用新的匿名 session 也接不回舊對話', async () => {
    const alice = await customer('alice@example.test');
    const conv = await startConversation(alice, 'ask');
    const socket = await open(url, '/customer', alice);
    await ack(socket, 'join', { conversationId: conv.id });
    logoutShop(alice); // 商店也登出：新的 session 是匿名（還登入著的話，同一位客戶本來就看得到自己的對話）
    await alice.post('/api/auth/customer/logout');
    await disconnected(socket);
    await alice.post('/api/auth/customer/session');
    const again = await open(url, '/customer', alice);
    expect(await ack(again, 'join', { conversationId: conv.id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('客服登出後，員工的連線也被斷開', async () => {
    const agent = await staff();
    const socket = await open(url, '/staff', agent);
    await agent.post('/api/auth/staff/logout');
    await disconnected(socket);
  });

  it('有新的 human 對話時，線上客服收到佇列更新，內容不含訊息', async () => {
    const agent = await staff();
    const agentSocket = await open(url, '/staff', agent);
    const updates = record(agentSocket, 'queue');
    const alice = await customer('alice@example.test');
    const conv = await startConversation(alice, 'human');
    await settle();
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates)).toContain(conv.id);
  });
});

describe('客服刪除自己接手的對話（AIC-019）', () => {
  const remove = (c: Client, id: string) =>
    c.request('DELETE', `/api/console/conversations/${id}`);

  it('從「我的對話」消失，但訊息還在（AC-25），並記下誰刪的', async () => {
    const alice = await customer('alice@example.test');
    const agent = await staff();
    const conv = await startConversation(alice, 'human');
    await agent.post(`/api/console/conversations/${conv.id}/assign`);
    const aliceSocket = await open(url, '/customer', alice);
    await ack(aliceSocket, 'join', { conversationId: conv.id });
    await ack(aliceSocket, 'send', { conversationId: conv.id, body: '還在嗎' });

    expect((await remove(agent, conv.id)).status).toBe(200);

    expect((await agent.get('/api/console/conversations')).body).toEqual([]);
    expect((await agent.get('/api/console/queue')).body).toEqual([]);
    const [[row]] = await db.query<RowDataPacket[]>(
      'SELECT status, closed_by, closed_at FROM conversations WHERE id = ?',
      [conv.id],
    );
    expect(row.status).toBe('closed');
    expect(row.closed_by).not.toBeNull();
    expect(row.closed_at).not.toBeNull();
    const [msgs] = await db.query<RowDataPacket[]>(
      'SELECT body FROM messages WHERE conversation_id = ? AND sender = ?',
      [conv.id, 'customer'],
    );
    expect(msgs.map((m) => m.body)).toEqual(['還在嗎']);
  });

  it('客戶收到對話結束的通知，之後送不出訊息；舊訊息還讀得到', async () => {
    const alice = await customer('alice@example.test');
    const agent = await staff();
    const conv = await startConversation(alice, 'human');
    await agent.post(`/api/console/conversations/${conv.id}/assign`);
    const aliceSocket = await open(url, '/customer', alice);
    const toAlice = record<{ body: string; sender: string }>(aliceSocket, 'message');
    await ack(aliceSocket, 'join', { conversationId: conv.id });
    await ack(aliceSocket, 'send', { conversationId: conv.id, body: '還在嗎' });

    await remove(agent, conv.id);
    await settle();

    expect(toAlice.at(-1)).toMatchObject({ sender: 'system', body: '這段對話已結束。' });
    expect(
      await ack(aliceSocket, 'send', { conversationId: conv.id, body: '哈囉？' }),
    ).toEqual({ ok: false, error: 'closed' });
    expect(
      (await alice.get(`/api/conversations/${conv.id}/messages`)).body.map(
        (m: { body: string }) => m.body,
      ),
    ).toEqual(['還在嗎', '這段對話已結束。']);
  });

  it('只能刪自己接手的：佇列裡的、別人的、AI 的、已刪的都不行', async () => {
    const alice = await customer('alice@example.test');
    const agent = await staff();
    const vet = await staff('vet@example.test');
    const queued = await startConversation(alice, 'human');
    const ask = await startConversation(alice, 'ask');
    const mine = await startConversation(alice, 'human');
    await agent.post(`/api/console/conversations/${mine.id}/assign`);

    expect((await remove(agent, queued.id)).status).toBe(404);
    expect((await remove(agent, ask.id)).status).toBe(404);
    expect((await remove(vet, mine.id)).status).toBe(404);
    expect((await remove(alice, mine.id)).status).toBe(401);
    expect((await remove(agent, 'not-a-uuid')).status).toBe(404);
    expect((await remove(agent, mine.id)).status).toBe(200);
    expect((await remove(agent, mine.id)).status).toBe(404);
  });
});

describe('推送當下再確認權限', () => {
  async function assignedPair() {
    const alice = await customer('alice@example.test');
    const agent = await staff();
    const conv = await startConversation(alice, 'human');
    await agent.post(`/api/console/conversations/${conv.id}/assign`);
    const aliceSocket = await open(url, '/customer', alice);
    const agentSocket = await open(url, '/staff', agent);
    await ack(aliceSocket, 'join', { conversationId: conv.id });
    await ack(agentSocket, 'join', { conversationId: conv.id });
    return {
      alice,
      agent,
      conv,
      aliceSocket,
      agentSocket,
      toAgent: record<{ body: string }>(agentSocket, 'message'),
    };
  }

  it('客服的 session 過期後，只在聽的連線也收不到新訊息，並被斷開', async () => {
    const { conv, aliceSocket, agentSocket, toAgent } = await assignedPair();
    await db.query(
      "UPDATE sessions SET expires_at = NOW(3) - INTERVAL 1 SECOND WHERE kind = 'staff'",
    );
    await ack(aliceSocket, 'send', {
      conversationId: conv.id,
      body: '過期後的訊息',
    });
    await disconnected(agentSocket);
    expect(toAgent).toEqual([]);
  });

  it('改派給別人後，原本的客服收不到新訊息和內部備註', async () => {
    const { conv, aliceSocket, toAgent } = await assignedPair();
    await db.query(
      "INSERT INTO staff (email, name, role, password_hash) VALUES ('s2@example.test', '客服二號', 'support_agent', 'x')",
    );
    await db.query(
      "UPDATE conversations SET assigned_agent_id = (SELECT id FROM staff WHERE email = 's2@example.test') WHERE id = ?",
      [conv.id],
    );
    await ack(aliceSocket, 'send', {
      conversationId: conv.id,
      body: '改派後的訊息',
    });
    await settle();
    expect(toAgent).toEqual([]);
  });

  it('客服改成獸醫後，收不到原本客服佇列的對話', async () => {
    const { conv, aliceSocket, toAgent } = await assignedPair();
    await db.query(
      "UPDATE staff SET role = 'vet' WHERE email = 'support@example.test'",
    );
    await ack(aliceSocket, 'send', {
      conversationId: conv.id,
      body: '角色變了',
    });
    await settle();
    expect(toAgent).toEqual([]);
  });

  it('客戶的 session 過期後，連線收不到客服的回覆', async () => {
    const { conv, agentSocket, aliceSocket } = await assignedPair();
    const toAlice = record(aliceSocket, 'message');
    await db.query(
      "UPDATE sessions SET expires_at = NOW(3) - INTERVAL 1 SECOND WHERE kind = 'customer'",
    );
    await ack(agentSocket, 'send', { conversationId: conv.id, body: '回覆' });
    await disconnected(aliceSocket);
    expect(toAlice).toEqual([]);
  });

  it('沒被指派的客服連著，也收不到對話內容', async () => {
    const { conv, aliceSocket } = await assignedPair();
    await db.query(
      "INSERT INTO staff (email, name, role, password_hash) SELECT 's2@example.test', '客服二號', 'support_agent', password_hash FROM staff WHERE email = 'support@example.test'",
    );
    const other = await open(url, '/staff', await staff('s2@example.test'));
    const toOther = record(other, 'message');
    await ack(aliceSocket, 'send', {
      conversationId: conv.id,
      body: '不該給別的客服',
    });
    await settle();
    expect(toOther).toEqual([]);
  });

  it('兩位客服各接一段對話，內部備註不會跑到對方', async () => {
    await db.query(
      "INSERT INTO staff (email, name, role, password_hash) SELECT 's2@example.test', '客服二號', 'support_agent', password_hash FROM staff WHERE email = 'support@example.test'",
    );
    const pairs = await Promise.all(
      [
        ['alice@example.test', 'support@example.test'],
        ['bob@example.test', 's2@example.test'],
      ].map(async ([c, s]) => {
        const cust = await customer(c);
        const agent = await staff(s);
        const conv = await startConversation(cust, 'human');
        await agent.post(`/api/console/conversations/${conv.id}/assign`);
        const socket = await open(url, '/staff', agent);
        await ack(socket, 'join', { conversationId: conv.id });
        return {
          conv,
          socket,
          got: record<{ conversation_id: string }>(socket, 'message'),
        };
      }),
    );
    await Promise.all(
      pairs.map((p) =>
        Promise.all(
          Array.from({ length: 30 }, (_, i) =>
            ack(p.socket, 'note', {
              conversationId: p.conv.id,
              body: `備註 ${i}`,
            }),
          ),
        ),
      ),
    );
    await settle(300);
    for (const p of pairs) {
      expect(p.got).toHaveLength(30);
      expect(p.got.every((m) => m.conversation_id === p.conv.id)).toBe(true);
    }
  });

  it('推送的訊息帶序號，前端可以照順序排', async () => {
    const { conv, aliceSocket, toAgent } = await assignedPair();
    await ack(aliceSocket, 'send', { conversationId: conv.id, body: '一' });
    await ack(aliceSocket, 'send', { conversationId: conv.id, body: '二' });
    await settle();
    const seqs = (toAgent as unknown as { seq: number }[]).map((m) => m.seq);
    expect(seqs).toHaveLength(2);
    expect(seqs[0]).toBeLessThan(seqs[1]);
  });
});

describe('log', () => {
  it('程式自己記的 log 也會遮掉 body、text、email、password', async () => {
    app.get(Logger).log(
      {
        body: 'CANARY-body',
        text: 'CANARY-text',
        email: 'canary@example.test',
        password: 'CANARY-pw',
      },
      'redaction check',
    );
    await waitForLog('redaction check');
    expect(logs()).not.toMatch(/CANARY-|canary@example/);
  });

  // socket 訊息不經過 HTTP log；這條守的是讀紀錄的 HTTP 回應
  it('AC-26：讀紀錄的 HTTP 請求不會把訊息內容寫進 log', async () => {
    const alice = await customer('alice@example.test');
    const conv = await startConversation(alice, 'ask');
    const socket = await open(url, '/customer', alice);
    await ack(socket, 'join', { conversationId: conv.id });
    await ack(socket, 'send', {
      conversationId: conv.id,
      body: 'CANARY-私密內容',
    });
    await alice.get(`/api/conversations/${conv.id}/messages`);
    await waitForLog(
      `"url":"/api/conversations/${conv.id}/messages"},"res":{"statusCode":200}`,
    );
    expect(logs()).not.toContain('CANARY-私密內容');
  });
});
