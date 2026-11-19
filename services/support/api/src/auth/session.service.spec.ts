import type { Pool } from 'mysql2/promise';
import { testDb, truncate } from '../../test/db.js';
import { SessionService } from './session.service.js';

let db: Pool;
let sessions: SessionService;
beforeAll(() => {
  db = testDb();
  sessions = new SessionService(db);
});
afterAll(() => db.end());
beforeEach(() => truncate(db));

describe('SessionService', () => {
  it('發出的 token 解得回來，種類不同就解不回來', async () => {
    const { token } = await sessions.create('customer', 7);
    expect(await sessions.resolve('customer', token)).toMatchObject({
      kind: 'customer',
      subjectId: 7,
    });
    expect(await sessions.resolve('staff', token)).toBeNull();
  });

  it('沒有、亂打、過長的 token 都解不回來', async () => {
    for (const bad of [undefined, '', 'x', 'a'.repeat(5000)])
      expect(await sessions.resolve('customer', bad)).toBeNull();
  });

  it('撤銷後立刻失效，並通知監聽的人（用來斷開 WebSocket）', async () => {
    const { token, hash } = await sessions.create('customer', null);
    const revoked: string[] = [];
    sessions.onRevoke((h) => revoked.push(h));
    await sessions.revoke(hash);
    expect(await sessions.resolve('customer', token)).toBeNull();
    expect(revoked).toEqual([hash]);
  });

  it('發新 session 時順手清掉過期的', async () => {
    await db.query(
      "INSERT INTO sessions (token_hash, kind, subject_id, expires_at) VALUES (REPEAT('a', 64), 'customer', NULL, NOW(3) - INTERVAL 1 DAY)",
    );
    await sessions.create('customer', 1);
    const [rows] = await db.query(
      "SELECT token_hash FROM sessions WHERE token_hash = REPEAT('a', 64)",
    );
    expect(rows).toEqual([]);
  });

  it('每次發的 token 都不一樣', async () => {
    const a = await sessions.create('customer', 1);
    const b = await sessions.create('customer', 1);
    expect(a.token).not.toBe(b.token);
  });
});
