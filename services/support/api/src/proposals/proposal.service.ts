import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Staff } from '../auth/auth.service.js';
import { ChatRealtime } from '../chat/chat.realtime.js';
import { ChatService } from '../chat/chat.service.js';
import { DB } from '../db/database.js';
import { ENV } from '../env.js';
import { SHOP_CLIENT, type ShopClient } from '../shop/shop-client.js';
import type { RunContext } from '../tools/run-token.service.js';
import { type ProposeArgs, ToolsService } from '../tools/tools.service.js';

export type ApproveResult =
  | {
      status: 'executed' | 'refund_pending' | 'refund_failed' | 'refund_timeout';
      refund_id: string;
      amount: number;
    }
  | { status: 'rejected_by_shop'; code: string }
  | { status: 'approving' | 'rejected' | 'pending' }
  | { status: 'forbidden' | 'not_found' | 'error' };

const RETRY_AFTER_SECONDS = 30; // 執行途中出錯：這段時間後才能再搶一次

/**
 * 提案和核准。AI 只能建立 pending 的提案；只有被指派的客服按下核准，才會向商店申請退款（ShopClient.requestRefund）。
 * 條件式 UPDATE 搶狀態，同時按 10 次也只執行一次。
 *
 * 退款是非同步的（AIC-016）：商店接受後是 refund_pending，每 3 秒問一次結果，最多 2 分鐘
 *   pending ─approve→ approving ─商店接受→ refund_pending ─SUCCEEDED→ executed
 *                         │                       ├─FAILED→ refund_failed
 *                         │                       └─2 分鐘沒結果→ refund_timeout（請到後台確認）
 *                         ├─商店拒絕→ rejected_by_shop
 *                         └─逾時、5xx→ approving（之後用同一個冪等鍵重試）
 */
@Injectable()
export class ProposalService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('proposals');
  private readonly pollMs: number;
  private readonly pollMaxMs: number;
  private readonly polling = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Pool,
    @Inject(SHOP_CLIENT) private readonly shop: ShopClient,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ChatRealtime) private readonly realtime: ChatRealtime,
    @Inject(ToolsService) private readonly tools: ToolsService,
    @Inject(ENV) env: NodeJS.ProcessEnv,
  ) {
    this.pollMs = Number(env.SUPPORT_REFUND_POLL_MS ?? 3000);
    this.pollMaxMs = Number(env.SUPPORT_REFUND_POLL_MAX_MS ?? 120_000);
  }

  /** AI 層只拿得到「建立」：propose_action 透過這個掛勾交過來 */
  async onModuleInit() {
    this.tools.setProposer((ctx, args) => this.create(ctx, args));
    // 重啟前還在等金流的：接著問
    const [rows] = await this.db.query<RowDataPacket[]>(
      "SELECT id, result_json FROM proposals WHERE status = 'refund_pending'",
    );
    for (const row of rows) this.watch(row.id, String(row.result_json.refundId));
  }

  async onApplicationShutdown() {
    this.stopped = true;
    await this.idle();
  }

  /** 等背景的輪詢都結束（測試和關閉服務用） */
  async idle() {
    while (this.polling.size) await Promise.allSettled(this.polling);
  }

  private watch(id: string, refundId: string) {
    const p = this.poll(id, refundId).finally(() => this.polling.delete(p));
    this.polling.add(p);
  }

  private async poll(id: string, refundId: string) {
    const until = Date.now() + this.pollMaxMs;
    while (!this.stopped && Date.now() < until) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      let state;
      try {
        state = await this.shop.refundStatus(refundId);
      } catch {
        continue; // 商店暫時連不上：下一輪再問
      }
      if (!state || state.status === 'PENDING') continue;
      await this.settle(id, state.status === 'SUCCEEDED' ? 'executed' : 'refund_failed', state.order_status);
      return;
    }
    if (!this.stopped) await this.settle(id, 'refund_timeout');
  }

  private async settle(id: string, status: string, orderStatus?: string) {
    await this.db.query(
      `UPDATE proposals SET status = ?, decided_at = NOW(3),
              result_json = JSON_SET(result_json, '$.status', ?, '$.order_status', ?)
        WHERE id = ? AND status = 'refund_pending'`,
      [status, status, orderStatus ?? null, id],
    );
    if (status !== 'executed') this.logger.warn(`提案 ${id} 的退款 ${status}`);
    await this.announce(id);
  }

  async create(ctx: RunContext, args: ProposeArgs) {
    if ((ctx.role !== 'agent' && ctx.role !== 'join') || !ctx.customerId)
      return null;
    const lines = Object.fromEntries(args.lines.map((l) => [l.item_id, l.qty]));
    // 金額和資格由 shop 算；訂單不是這位客戶的，提案就建立不起來
    const preview = await this.shop.refundPreview(ctx.customerId, args.order_no, lines);
    if (!preview) return null;
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO proposals (id, conversation_id, run_id, type, params_json, judgment, reason, refs_json, preview_json, status)
       VALUES (?, ?, ?, 'refund', ?, ?, ?, ?, ?, 'pending')`,
      [
        id,
        ctx.conversationId,
        ctx.runId,
        JSON.stringify({ order_no: args.order_no, lines }),
        args.judgment,
        args.reason,
        JSON.stringify(args.refs ?? []),
        JSON.stringify(preview),
      ],
    );
    await this.announce(id);
    return { id, status: 'pending', preview };
  }

  async approve(id: string, staff: Staff): Promise<ApproveResult> {
    const p = await this.get(id);
    if (!p) return { status: 'not_found' };
    if (!(await this.mayDecide(p.conversation_id, staff)))
      return { status: 'forbidden' };

    const [claim] = await this.db.query<ResultSetHeader>(
      `UPDATE proposals SET status = 'approving', claimed_at = NOW(3), decided_by = ?
        WHERE id = ? AND (status = 'pending' OR (status = 'approving' AND claimed_at < NOW(3) - INTERVAL ? SECOND))`,
      [staff.id, id, RETRY_AFTER_SECONDS],
    );
    if (claim.affectedRows !== 1) return this.current(id); // 已經被處理或別人正在處理

    const conv = await this.chat.get(p.conversation_id);
    let result;
    try {
      const res = await this.shop.requestRefund(conv!.customer_id!, p.params_json.order_no, {
        lines: p.params_json.lines,
        idempotencyKey: `support-proposal:${id}`, // 重試、並發都只會退一次（商店的唯一索引保證）
        staffId: staff.id,
        proposalId: id,
      });
      result =
        res.status === 'accepted'
          ? { status: 'refund_pending', refundId: res.refundId, amount: res.amount }
          : { status: 'rejected', code: res.code };
    } catch {
      // 不知道錢有沒有動：保持 approving，之後重試帶同一個冪等鍵，不會多退
      return { status: 'error' };
    }
    const status =
      result.status === 'refund_pending' ? 'refund_pending' : 'rejected_by_shop';
    await this.db.query(
      "UPDATE proposals SET status = ?, result_json = ?, decided_at = NOW(3) WHERE id = ? AND status = 'approving'",
      [status, JSON.stringify(result), id],
    );
    if (result.status === 'refund_pending') this.watch(id, result.refundId!);
    await this.announce(id);
    return this.current(id);
  }

  async reject(id: string, staff: Staff): Promise<ApproveResult> {
    const p = await this.get(id);
    if (!p) return { status: 'not_found' };
    if (!(await this.mayDecide(p.conversation_id, staff)))
      return { status: 'forbidden' };
    await this.db.query(
      "UPDATE proposals SET status = 'rejected', decided_by = ?, decided_at = NOW(3) WHERE id = ? AND status = 'pending'",
      [staff.id, id],
    );
    await this.announce(id);
    return this.current(id);
  }

  async list(conversationId: string, staff: Staff) {
    if (!(await this.chat.staffCanAccess(conversationId, staff))) return null;
    const [rows] = await this.db.query<RowDataPacket[]>(
      'SELECT * FROM proposals WHERE conversation_id = ? ORDER BY created_at',
      [conversationId],
    );
    return rows;
  }

  /** 只有被指派的客服能決定；獸醫沒有退款權限 */
  private async mayDecide(conversationId: string, staff: Staff) {
    return (
      staff.role === 'support_agent' &&
      (await this.chat.staffCanAccess(conversationId, staff))
    );
  }

  private async get(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const [[row]] = await this.db.query<RowDataPacket[]>(
      'SELECT * FROM proposals WHERE id = ?',
      [id],
    );
    return row as
      | {
          id: string;
          conversation_id: string;
          status: string;
          params_json: { order_no: string; lines: Record<number, number> };
          result_json: unknown;
        }
      | undefined;
  }

  private async current(id: string): Promise<ApproveResult> {
    const p = (await this.get(id))!;
    const r = p.result_json as {
      status: string;
      refundId?: string;
      amount?: number;
      code?: string;
    } | null;
    if (
      ['executed', 'refund_pending', 'refund_failed', 'refund_timeout'].includes(p.status) &&
      r?.refundId
    )
      return {
        status: p.status as 'executed',
        refund_id: r.refundId,
        amount: r.amount!,
      };
    if (p.status === 'rejected_by_shop' && r?.code)
      return { status: 'rejected_by_shop', code: r.code };
    return { status: p.status as 'approving' | 'rejected' | 'pending' };
  }

  /** 提案卡片只發到客服的房間 */
  private async announce(id: string) {
    const [[row]] = await this.db.query<RowDataPacket[]>(
      'SELECT * FROM proposals WHERE id = ?',
      [id],
    );
    if (row)
      await this.realtime.emit(
        row.conversation_id,
        'internal',
        'proposal',
        row,
      );
  }
}
