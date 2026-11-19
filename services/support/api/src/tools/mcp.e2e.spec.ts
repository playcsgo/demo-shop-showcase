import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { aiRun } from '../../test/ai-fixtures.js';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { shopFixture } from '../../test/fixtures.js';
import { startApp } from '../../test/http.js';
import { seed } from '../db/seed.js';
import { RunTokenService } from './run-token.service.js';

let db: Pool;
let app: INestApplication;
let url: string;
beforeAll(async () => {
  db = testDb();
  ({ app, url } = await startApp());
});
afterAll(async () => {
  await app.close();
  await db.end();
});
let alice: number;
beforeEach(async () => {
  await truncate(db);
  await seed(db, testEnv);
  ({ alice } = await shopFixture(db));
});

async function token(role: 'anonymous' | 'customer' | 'agent' = 'customer') {
  const { runId, conversationId } = await aiRun(db);
  return app.get(RunTokenService).issue({
    runId,
    conversationId,
    role,
    customerId: role === 'anonymous' ? null : alice,
    agentId: null,
  });
}
async function rpc(body: unknown, auth?: string) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('/mcp', () => {
  it('沒有 token、亂打、撤銷後都被拒', async () => {
    const t = await token();
    expect(
      (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status,
    ).toBe(401);
    expect(
      (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope'))
        .status,
    ).toBe(401);
    app.get(RunTokenService).revoke(t);
    expect(
      (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, t)).status,
    ).toBe(401);
  });

  it('握手、列工具、呼叫工具', async () => {
    const t = await token();
    const init = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
      t,
    );
    expect(init.body.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
    });
    expect(
      (await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, t))
        .status,
    ).toBe(202);
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, t);
    expect(
      list.body.result.tools.map((x: { name: string }) => x.name),
    ).toContain('get_order');
    const call = await rpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_stock', arguments: { sku: 'DCS-PRO-30' } },
      },
      t,
    );
    expect(JSON.parse(call.body.result.content[0].text)).toMatchObject({
      stock: { in_stock: true },
    });
  });

  it('未知方法回 -32601：CLI 連線時的探測不用白等', async () => {
    const r = await rpc(
      {
        jsonrpc: '2.0',
        id: 'server-discover-probe-1',
        method: 'server/discover',
      },
      await token(),
    );
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id: 'server-discover-probe-1',
      error: { code: -32601, message: 'Method not found' },
    });
  });

  it('工具清單只有這個角色能用的', async () => {
    const list = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      await token('anonymous'),
    );
    expect(
      list.body.result.tools.map((x: { name: string }) => x.name),
    ).not.toContain('get_order');
  });
});
