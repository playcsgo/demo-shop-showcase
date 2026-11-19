import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { DB } from '../db/database.js';

export type SessionKind = 'customer' | 'staff';
export interface Session {
  hash: string;
  kind: SessionKind;
  subjectId: number | null; // 客戶未登入時為 null
}

const TTL_DAYS = 7;
const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** cookie 只放隨機值，資料表存雜湊：登出能立刻失效，資料庫外洩也不能直接登入 */
@Injectable()
export class SessionService {
  private readonly listeners = new Set<(hash: string) => void>();

  constructor(@Inject(DB) private readonly db: Pool) {}

  async create(
    kind: SessionKind,
    subjectId: number | null,
  ): Promise<{ token: string; hash: string }> {
    const token = randomBytes(32).toString('base64url');
    const hash = hashToken(token);
    // 順手清掉過期的，不另外跑排程
    await this.db.query(
      'DELETE FROM sessions WHERE expires_at < NOW(3) LIMIT 100',
    );
    await this.db.query(
      'INSERT INTO sessions (token_hash, kind, subject_id, expires_at) VALUES (?, ?, ?, NOW(3) + INTERVAL ? DAY)',
      [hash, kind, subjectId, TTL_DAYS],
    );
    return { token, hash };
  }

  async resolve(
    kind: SessionKind,
    token: string | undefined,
  ): Promise<Session | null> {
    if (!token || token.length > 100) return null;
    const hash = hashToken(token);
    const [rows] = await this.db.query<RowDataPacket[]>(
      'SELECT subject_id FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > NOW(3)',
      [hash, kind],
    );
    return rows[0] ? { hash, kind, subjectId: rows[0].subject_id } : null;
  }

  /** 推送前用：連線只記得 session 的雜湊，要確認它現在還有效 */
  async active(hash: string, kind: SessionKind): Promise<Session | null> {
    const [rows] = await this.db.query<RowDataPacket[]>(
      'SELECT subject_id FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > NOW(3)',
      [hash, kind],
    );
    return rows[0] ? { hash, kind, subjectId: rows[0].subject_id } : null;
  }

  async revoke(hash: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE token_hash = ?', [hash]);
    for (const listener of this.listeners) listener(hash);
  }

  /** WebSocket 用：session 撤銷時斷開連線 */
  onRevoke(listener: (hash: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
