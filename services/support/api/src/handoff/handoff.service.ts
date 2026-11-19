import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ChatRealtime } from '../chat/chat.realtime.js';
import { ChatService, type Queue } from '../chat/chat.service.js';
import { DB } from '../db/database.js';

export const HANDOFF_TEXT = {
  cs: '這個我幫你查一下，請稍等。',
  vet: '我請獸醫協助你，請稍等。',
  noneOnline: {
    cs: '目前沒有客服在線，我們會盡快回覆你。',
    vet: '目前沒有獸醫在線，我們會盡快回覆你。',
  },
  urgent: '我請獸醫協助你，這個情況建議儘快就醫。',
  urgentNoneOnline:
    '目前沒有獸醫在線，我們會盡快回覆你。情況緊急請直接帶去就醫。',
} as const;

export type ReasonCode =
  | 'attack'
  | 'wants_human'
  | 'upset'
  | 'medical'
  | 'router_failed'
  | 'ai_transfer'
  | 'ai_error';

/**
 * 轉接：一律直接轉，不詢問（AC-15）。先改狀態、回客戶，再補摘要：客戶不用等摘要。
 * 只從 active 轉出，條件式 UPDATE 確保同一段對話只轉一次
 */
@Injectable()
export class HandoffService {
  constructor(
    @Inject(DB) private readonly db: Pool,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ChatRealtime) private readonly realtime: ChatRealtime,
  ) {}

  async handoff(
    conversationId: string,
    opts: {
      queue: Queue;
      reason: ReasonCode;
      flaggedAttack?: boolean;
      urgent?: boolean; // 危險症狀：建議儘快就醫
      summarize: () => Promise<string | null>;
    },
  ) {
    const online = this.realtime
      .onlineRoles()
      .has(opts.queue === 'vet' ? 'vet' : 'support_agent');
    const status = online ? 'queued' : 'pending';
    const [res] = await this.db.query<ResultSetHeader>(
      "UPDATE conversations SET status = ?, queue = ? WHERE id = ? AND status = 'active'",
      [status, opts.queue, conversationId],
    );
    if (res.affectedRows !== 1) return; // 已經轉過了

    // AC-17：客戶看到的文字不含原因
    const text = opts.urgent
      ? online
        ? HANDOFF_TEXT.urgent
        : HANDOFF_TEXT.urgentNoneOnline
      : online
        ? HANDOFF_TEXT[opts.queue]
        : HANDOFF_TEXT.noneOnline[opts.queue];
    await this.realtime.publish(
      await this.chat.postSystem(conversationId, text),
    );

    const summary = await opts.summarize().catch(() => null);
    await this.db.query(
      'INSERT INTO handoffs (id, conversation_id, reason_code, queue, flagged_attack, summary) VALUES (?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        conversationId,
        opts.reason,
        opts.queue,
        opts.flaggedAttack ? 1 : 0,
        summary,
      ],
    );
    if (!online) {
      await this.db.query(
        "INSERT IGNORE INTO pending_tickets (conversation_id, queue, status) VALUES (?, ?, 'open')",
        [conversationId, opts.queue],
      );
    }
    this.realtime.queueChanged(conversationId);
  }

  async latest(conversationId: string) {
    const [rows] = await this.db.query<RowDataPacket[]>(
      'SELECT reason_code, queue, flagged_attack, summary, created_at FROM handoffs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1',
      [conversationId],
    );
    return rows[0]
      ? { ...rows[0], flagged_attack: rows[0].flagged_attack === 1 }
      : null;
  }
}
