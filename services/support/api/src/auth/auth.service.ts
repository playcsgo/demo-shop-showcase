import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { DB } from '../db/database.js';
import { CUSTOMER_COOKIE, readCookie, STAFF_COOKIE } from './cookies.js';
import { hashPassword, verifyPassword } from './password.js';
import { type Session, SessionService } from './session.service.js';
import { SHOP_SESSIONS, SHOP_SID_COOKIE, type ShopSessions } from './shop-session.js';

export interface Customer {
  id: number;
  name: string;
}
export interface Staff {
  id: number;
  name: string;
  role: 'support_agent' | 'vet';
}

// 帳號不存在時也算一次雜湊：回應時間不會透露帳號是否存在
const DUMMY_HASH = hashPassword('not-a-real-password');

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Pool,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SHOP_SESSIONS) private readonly shop: ShopSessions,
  ) {}

  /** 商店說這個瀏覽器是哪位客戶（AIC-015）；沒登入商店就是 null。結果快取 30 秒，每個請求都可以問 */
  async shopCustomer(cookieHeader: string | undefined): Promise<Customer | null> {
    const who = await this.shop.resolve(readCookie(cookieHeader, SHOP_SID_COOKIE));
    return who && { id: who.customerId, name: who.name };
  }

  /** 開 session 時記下名字，給控制台的佇列顯示（只是快取，不是帳號） */
  async rememberCustomer(customer: Customer) {
    await this.db.query(
      'INSERT INTO shop_customers (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [customer.id, customer.name],
    );
  }

  async checkStaff(email: string, password: string): Promise<Staff | null> {
    const row = await this.check('staff', email, password);
    return row && { id: row.id, name: row.name, role: row.role };
  }

  private async check(table: 'staff', email: string, password: string) {
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT * FROM ${table} WHERE email = ?`,
      [email],
    );
    const ok = await verifyPassword(
      password,
      rows[0]?.password_hash ?? (await DUMMY_HASH),
    );
    return ok && rows[0] ? rows[0] : null;
  }

  /**
   * 客戶的 session；未登入的匿名 session 也算，customer 為 null。
   * 每次都和商店的登入比對（AC-34）：在商店登出或換了帳號，這個 session 就作廢，
   * 連線一起斷開，前一個人的對話不會被接續
   */
  async customerFromCookies(cookieHeader: string | undefined) {
    const session = await this.sessions.resolve(
      'customer',
      readCookie(cookieHeader, CUSTOMER_COOKIE),
    );
    if (!session) return null;
    const now = await this.shopCustomer(cookieHeader);
    if ((now?.id ?? null) !== session.subjectId) {
      await this.sessions.revoke(session.hash);
      return null;
    }
    return this.customerOf(session);
  }

  async customerBySession(hash: string) {
    const session = await this.sessions.active(hash, 'customer');
    return session ? this.customerOf(session) : null;
  }

  async staffFromCookies(cookieHeader: string | undefined) {
    const session = await this.sessions.resolve(
      'staff',
      readCookie(cookieHeader, STAFF_COOKIE),
    );
    return session ? this.staffOf(session) : null;
  }

  async staffBySession(hash: string) {
    const session = await this.sessions.active(hash, 'staff');
    return session ? this.staffOf(session) : null;
  }

  private async customerOf(
    session: Session,
  ): Promise<{ session: Session; customer: Customer | null } | null> {
    if (session.subjectId === null) return { session, customer: null };
    const [rows] = await this.db.query<RowDataPacket[]>(
      'SELECT name FROM shop_customers WHERE id = ?',
      [session.subjectId],
    );
    return {
      session,
      customer: { id: session.subjectId, name: rows[0]?.name ?? '' },
    };
  }

  /** 每次都重讀 staff：角色改了要立刻生效 */
  private async staffOf(
    session: Session,
  ): Promise<{ session: Session; staff: Staff } | null> {
    const [rows] = await this.db.query<RowDataPacket[]>(
      'SELECT id, name, role FROM staff WHERE id = ?',
      [session.subjectId],
    );
    return rows[0]
      ? {
          session,
          staff: { id: rows[0].id, name: rows[0].name, role: rows[0].role },
        }
      : null;
  }
}
