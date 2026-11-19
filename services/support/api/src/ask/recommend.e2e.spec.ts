import type { INestApplication } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Socket } from 'socket.io-client';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { FakeLlm } from '../../test/fake-llm.js';
import { shopFixture } from '../../test/fixtures.js';
import { Client, startApp } from '../../test/http.js';
import { ack, connect, record, settle } from '../../test/socket.js';
import { seed } from '../db/seed.js';
import { AskService } from './ask.service.js';

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
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await truncate(db);
  await seed(db, testEnv);
  await shopFixture(db);
  llm.inputs.length = 0;
  llm.fastInputs.length = 0;
  llm.route = () => [{ json: { intent: 'normal', reason: '測試' } }];
  llm.script = () => [{ text: '好的' }];
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await app.get(AskService).idle();
});

type Msg = { sender: string; body: string; attachment_key?: string | null };
async function chat() {
  const c = new Client(url);
  await c.post('/api/auth/customer/session');
  const conv = (await c.post('/api/conversations', { mode: 'ask' })).body;
  const socket = await connect(url, '/customer', c);
  sockets.push(socket);
  await ack(socket, 'join', { conversationId: conv.id });
  const got = record<Msg>(socket, 'message');
  return { c, conv, socket, got };
}
async function ask(text: string) {
  const r = await chat();
  await ack(r.socket, 'send', { conversationId: r.conv.id, body: text });
  for (let i = 0; i < 150 && !r.got.some((m) => m.sender !== 'customer'); i++)
    await settle(20);
  await app.get(AskService).idle();
  await settle(100); // 背景做完後，socket 事件還要一點時間才送到
  return r;
}
const replies = (got: Msg[]) => got.filter((m) => m.sender !== 'customer');
const medical = (level?: string) => () => [
  {
    json: {
      intent: 'medical',
      reason: '健康',
      ...(level ? { medical_level: level } : {}),
    },
  },
];
const convRow = async (id: string) =>
  (
    await db.query<RowDataPacket[]>(
      'SELECT status, queue FROM conversations WHERE id = ?',
      [id],
    )
  )[0][0];

describe('AC-21：不適用警示', () => {
  it('讀了商品全文，警示由伺服器產生，排在 AI 的回答前面', async () => {
    llm.script = () => [
      { tool: 'get_product_doc', args: { slug: 'probiotics' } },
      { text: '推薦益生菌[[ref:product_doc:probiotics]]' },
    ];
    const { got } = await ask('拉肚子吃什麼好');
    const r = replies(got);
    expect(r[0]).toMatchObject({ sender: 'system', attachment_key: 'warning' });
    expect(r[0].body).toContain('抗生素');
    expect(r[1]).toMatchObject({ sender: 'ai' });
  });

  it('沒寫不適用條件的商品顯示「資料未載明」，不是空白', async () => {
    llm.script = () => [
      { tool: 'get_product_doc', args: { slug: 'cat-grass-kit' } },
      { text: '可以試試貓草' },
    ];
    const { got } = await ask('有推薦的貓草嗎');
    expect(replies(got)[0].body).toContain('資料未載明');
  });

  it('模型的回答自稱「適合所有貓」，警示照樣在', async () => {
    llm.script = () => [
      { tool: 'get_product_doc', args: { slug: 'fresh-meat-can' } },
      { text: '這款適合所有貓咪！' },
    ];
    const { got } = await ask('鮮肉罐適合我的貓嗎');
    expect(
      replies(got).some(
        (m) => m.attachment_key === 'warning' && m.body.includes('腎'),
      ),
    ).toBe(true);
  });

  it('串流被取消時，警示仍然留在紀錄裡', async () => {
    llm.script = (input) =>
      input.messages.length === 1
        ? [
            { tool: 'get_product_doc', args: { slug: 'probiotics' } },
            { hang: true },
          ]
        : [{ text: '好' }];
    const r = await chat();
    await ack(r.socket, 'send', {
      conversationId: r.conv.id,
      body: '推薦益生菌',
    });
    for (
      let i = 0;
      i < 100 && !r.got.some((m) => m.attachment_key === 'warning');
      i++
    )
      await settle(20);
    await ack(r.socket, 'send', { conversationId: r.conv.id, body: '算了' });
    await app.get(AskService).idle();
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT body FROM messages WHERE conversation_id = ? AND attachment_key = 'warning'",
      [r.conv.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('AC-20：醫療分級', () => {
  it('預防保養：推薦，不轉接', async () => {
    llm.route = medical('prevention');
    const { conv, got } = await ask('要預防貓咪骨折有什麼推薦');
    expect(llm.inputs).toHaveLength(1);
    expect(replies(got).some((m) => m.sender === 'ai')).toBe(true);
    expect(await convRow(conv.id)).toMatchObject({ status: 'active' });
  });

  it('輕微症狀：先推薦，回答完再轉獸醫', async () => {
    llm.route = medical('mild_symptom');
    const { conv, got } = await ask('貓咪最近拉肚子該吃什麼');
    expect(llm.inputs).toHaveLength(1);
    const r = replies(got);
    expect(r.findIndex((m) => m.sender === 'ai')).toBeLessThan(
      r.findIndex((m) => m.body.includes('獸醫')),
    );
    expect(await convRow(conv.id)).toMatchObject({ queue: 'vet' });
  });

  it.each(['diagnosis_or_danger', undefined])(
    '診斷或危險症狀（等級 %s）：不推薦，直接轉獸醫並建議就醫；拿不準時當成最嚴重',
    async (level) => {
      llm.route = medical(level);
      const { conv, got } = await ask('貓咪血便');
      expect(llm.inputs).toHaveLength(0);
      expect(replies(got).at(-1)?.body).toContain('就醫');
      expect(await convRow(conv.id)).toMatchObject({ queue: 'vet' });
    },
  );
});

describe('SOP 引用', () => {
  it('回答可以引用 SOP 條目', async () => {
    llm.script = () => [
      { tool: 'get_sop', args: { topic: 'refund' } },
      { text: '已開封的食品不能退[[ref:sop:refund#E2]]' },
    ];
    const { got } = await ask('開過的飼料可以退嗎');
    expect(replies(got).find((m) => m.sender === 'ai')).toMatchObject({
      body: '已開封的食品不能退',
    });
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT JSON_KEYS(refs_json) AS k FROM messages WHERE sender = 'ai'",
    );
    expect(rows[0].k).toEqual(['sop:refund#E2']);
  });
});
