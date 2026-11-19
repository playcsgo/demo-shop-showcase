import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import type { Customer, Staff } from '../auth/auth.service.js';
import type { Session } from '../auth/session.service.js';
import { DB } from '../db/database.js';

export type Mode = 'ask' | 'human';
export type Visibility = 'public' | 'internal';
export type Queue = 'cs' | 'vet';

export interface Conversation {
  id: string;
  mode: Mode;
  status: 'active' | 'queued' | 'assigned' | 'pending' | 'closed';
  queue: Queue | null;
  customer_id: number | null;
  assigned_agent_id: number | null;
  join_enabled_at?: Date | null;
  created_at: Date;
}
export interface Message {
  id: string;
  seq: number; // 排序用：即時推送的到達順序不一定等於寫入順序
  conversation_id: string;
  sender: 'customer' | 'agent' | 'ai' | 'system';
  sender_id: number | null;
  visibility: Visibility;
  body: string;
  refs_json?: Record<string, unknown> | null;
  attachment_key?: string | null; // 固定圖片（AC-7） // AI 回答引用的資料（當時工具回傳的內容）
  created_at: Date;
}

export class ChatError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'not_assigned'
      | 'invalid_body'
      | 'not_found'
      | 'closed',
  ) {
    super(code);
  }
}

const MAX_BODY = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const queueOf = (role: Staff['role']): Queue => (role === 'vet' ? 'vet' : 'cs');

function validBody(body: unknown): string {
  if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY)
    throw new ChatError('invalid_body');
  return body;
}

/** 對話和訊息。所有存取都以 conversation_id 為 key，並檢查呼叫的人有沒有權限 */
@Injectable()
export class ChatService {
  constructor(@Inject(DB) private readonly db: Pool) {}

  async start(
    session: Session,
    customer: Customer | null,
    mode: Mode,
  ): Promise<Conversation> {
    const id = randomUUID();
    const [status, queue] =
      mode === 'human' ? ['queued', 'cs'] : ['active', null];
    await this.db.query(
      'INSERT INTO conversations (id, mode, status, session_hash, customer_id, queue) VALUES (?, ?, ?, ?, ?, ?)',
      [id, mode, status, session.hash, customer?.id ?? null, queue],
    );
    return (await this.get(id))!;
  }

  async get(
    id: string,
  ): Promise<(Conversation & { session_hash: string }) | null> {
    if (!UUID.test(id)) return null;
    const [rows] = await this.db.query<RowDataPacket[]>(
      'SELECT * FROM conversations WHERE id = ?',
      [id],
    );
    return (rows[0] as Conversation & { session_hash: string }) ?? null;
  }

  /** 開對話的那個 session，或同一位登入的客戶（換了裝置也看得到）。匿名對話只認 session */
  async customerCanAccess(
    id: string,
    session: Session,
    customer: Customer | null,
  ): Promise<boolean> {
    const conv = await this.get(id);
    if (!conv) return false;
    return (
      conv.session_hash === session.hash ||
      (customer !== null && conv.customer_id === customer.id)
    );
  }

  async staffCanAccess(id: string, staff: Staff): Promise<boolean> {
    const conv = await this.get(id);
    // 角色也要對：客服改成獸醫後，不能再碰客服佇列的對話
    return (
      conv?.status === 'assigned' &&
      conv.assigned_agent_id === staff.id &&
      conv.queue === queueOf(staff.role)
    );
  }

  async postCustomer(
    id: string,
    session: Session,
    customer: Customer | null,
    body: unknown,
  ): Promise<Message[]> {
    const text = validBody(body);
    // 交易外先查：交易裡再向連線池借連線，同時送出的人一多就會互等到死結
    if (!(await this.customerCanAccess(id, session, customer)))
      throw new ChatError('forbidden');
    // 客服刪掉（結束）的對話不再收訊息：沒有人會看到（AIC-019）
    if ((await this.get(id))?.status === 'closed') throw new ChatError('closed');
    return this.withLiveSession(session, async (conn) => [
      await this.insert(
        conn,
        id,
        'customer',
        customer?.id ?? null,
        'public',
        text,
      ),
    ]);
  }

  async postAgent(
    id: string,
    session: Session,
    staff: Staff,
    body: unknown,
    visibility: Visibility,
  ): Promise<Message> {
    const text = validBody(body);
    if (!(await this.staffCanAccess(id, staff)))
      throw new ChatError('not_assigned');
    return this.withLiveSession(session, (conn) =>
      this.insert(conn, id, 'agent', staff.id, visibility, text),
    );
  }

  /**
   * 鎖住 session 那一列直到訊息寫完。登出（DELETE）要等這裡提交才能刪，
   * 這裡也要等登出提交才讀得到結果：兩者不會交錯，登出後不會再多一則訊息
   */
  private async withLiveSession<T>(
    session: Session,
    run: (conn: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT 1 FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > NOW(3) FOR SHARE',
        [session.hash, session.kind],
      );
      if (!rows.length) throw new ChatError('forbidden');
      const result = await run(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** AI 的回答。引用的資料一起存：之後核對的是 AI 當時看到的，不是之後查到的 */
  postAi(
    id: string,
    body: string,
    visibility: Visibility,
    refs: Record<string, unknown> | null,
  ): Promise<Message> {
    return this.insert(
      this.db,
      id,
      'ai',
      null,
      visibility,
      body,
      refs && Object.keys(refs).length ? refs : null,
    );
  }

  /** AC-7：固定圖片，不由模型生成 */
  postImage(id: string, attachmentKey: string, alt: string): Promise<Message> {
    return this.insert(
      this.db,
      id,
      'ai',
      null,
      'public',
      alt,
      null,
      attachmentKey,
    );
  }

  /** AC-21：不適用警示，由伺服器產生，不經過模型 */
  postWarning(
    id: string,
    body: string,
    visibility: Visibility,
  ): Promise<Message> {
    return this.insert(
      this.db,
      id,
      'system',
      null,
      visibility,
      body,
      null,
      'warning',
    );
  }

  postSystem(
    id: string,
    body: string,
    visibility: Visibility = 'public',
  ): Promise<Message> {
    return this.insert(this.db, id, 'system', null, visibility, body);
  }

  /** AC-8：只有被指派的客服能開關 Join；開啟時間有存 */
  async setJoin(id: string, staff: Staff, on: boolean): Promise<boolean> {
    if (!(await this.staffCanAccess(id, staff))) return false;
    await this.db.query(
      'UPDATE conversations SET join_enabled_at = ? WHERE id = ?',
      [on ? new Date() : null, id],
    );
    return true;
  }

  /** AC-2：登入按鈕一段對話只出現一次。條件式 UPDATE，同時兩次也只有一次成功 */
  async markLoginPrompted(id: string): Promise<boolean> {
    const [res] = await this.db.query<ResultSetHeader>(
      'UPDATE conversations SET login_prompted_at = NOW(3) WHERE id = ? AND login_prompted_at IS NULL',
      [id],
    );
    return res.affectedRows === 1;
  }

  async history(id: string, viewer: 'customer' | 'staff'): Promise<Message[]> {
    const onlyPublic = viewer === 'customer' ? "AND visibility = 'public'" : '';
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT id, seq, conversation_id, sender, sender_id, visibility, body, refs_json, attachment_key, created_at FROM messages WHERE conversation_id = ? ${onlyPublic} ORDER BY seq`,
      [id],
    );
    return rows as Message[];
  }

  /** 佇列摘要：沒被指派的人也看得到，所以不含訊息內容 */
  async queue(role: Staff['role']) {
    // AC-18：沒人在線時的待回覆單（pending）也列出來；只帶轉接原因的代碼和標記，不帶訊息內容
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT c.id, c.mode, c.queue, c.status, c.created_at, COALESCE(u.name, '訪客') AS customer_name,
              h.reason_code, COALESCE(h.flagged_attack, 0) AS flagged_attack
         FROM conversations c
         LEFT JOIN shop_customers u ON u.id = c.customer_id
         LEFT JOIN handoffs h ON h.id = (SELECT id FROM handoffs WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1)
        WHERE c.status IN ('queued', 'pending') AND c.queue = ? ORDER BY c.created_at, c.id`,
      [queueOf(role)],
    );
    return rows.map((r) => ({
      ...r,
      flagged_attack: r.flagged_attack === 1,
    })) as {
      id: string;
      mode: Mode;
      queue: Queue;
      status: 'queued' | 'pending';
      created_at: Date;
      customer_name: string;
      reason_code: string | null;
      flagged_attack: boolean;
    }[];
  }

  /** 條件式 UPDATE：兩個人同時接手只有一個成功；也只能接自己角色的佇列 */
  async assign(id: string, staff: Staff): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const [res] = await this.db.query<ResultSetHeader>(
      "UPDATE conversations SET status = 'assigned', assigned_agent_id = ? WHERE id = ? AND status IN ('queued', 'pending') AND queue = ?",
      [staff.id, id, queueOf(staff.role)],
    );
    if (res.affectedRows !== 1) return false;
    await this.db.query(
      "UPDATE pending_tickets SET status = 'taken', taken_by = ? WHERE conversation_id = ? AND status = 'open'",
      [staff.id, id],
    );
    return true;
  }

  /**
   * 刪除＝結束並從控制台隱藏（AIC-019）：只有接手的客服、同一個佇列的角色能刪。
   * 條件式 UPDATE，刪過的再刪一次就不成立。訊息都留著（AC-25）
   */
  async close(id: string, staff: Staff): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const [res] = await this.db.query<ResultSetHeader>(
      "UPDATE conversations SET status = 'closed', closed_by = ?, closed_at = NOW(3) WHERE id = ? AND status = 'assigned' AND assigned_agent_id = ? AND queue = ?",
      [staff.id, id, staff.id, queueOf(staff.role)],
    );
    return res.affectedRows === 1;
  }

  async assignedTo(staff: Staff) {
    const [rows] = await this.db.query<RowDataPacket[]>(
      `SELECT c.id, c.mode, c.queue, c.created_at, COALESCE(u.name, '訪客') AS customer_name
         FROM conversations c LEFT JOIN shop_customers u ON u.id = c.customer_id
        WHERE c.status = 'assigned' AND c.assigned_agent_id = ? ORDER BY c.updated_at DESC`,
      [staff.id],
    );
    return rows;
  }

  private async insert(
    conn: Pool | PoolConnection,
    conversationId: string,
    sender: Message['sender'],
    senderId: number | null,
    visibility: Visibility,
    body: string,
    refs: Record<string, unknown> | null = null,
    attachmentKey: string | null = null,
  ): Promise<Message> {
    const id = randomUUID();
    await conn.query(
      'INSERT INTO messages (id, conversation_id, sender, sender_id, visibility, body, refs_json, attachment_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        conversationId,
        sender,
        senderId,
        visibility,
        body,
        refs ? JSON.stringify(refs) : null,
        attachmentKey,
      ],
    );
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT id, seq, conversation_id, sender, sender_id, visibility, body, refs_json, attachment_key, created_at FROM messages WHERE id = ?',
      [id],
    );
    return rows[0] as Message;
  }
}
