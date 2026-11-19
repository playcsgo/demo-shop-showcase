import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { deterministicId, Envelope, envelope } from '../common/envelope.js';
import { orderLifecycle } from '../common/metrics.js';
import { PartnerRejectedError } from '../common/resilience/partner-http.js';
import { REDIS } from '../messaging/redis.provider.js';
import { SqsService } from '../messaging/sqs.service.js';
import { ClinicAdapter, LineAdapter, LogisticsAdapter, PaymentAdapter } from '../partners/adapters.js';

export const EVENTS_QUEUE = 'integration-events';

/**
 * 處理 core 送來的指令（core-commands 佇列）。
 * 規則：
 *  - 廠商「確定拒絕」（4xx）→ 回報失敗事件給 core（例如 payment.failed、booking.failed）
 *  - 「沒收到回應」不等於失敗（付款、醫院確認都一樣）：重試或查詢，不能猜
 *  - 暫時性錯誤（5xx、逾時、斷路器打開）→ 丟出例外 → 訊息不刪 → SQS 稍後重送 → 5 次後進 DLQ
 *  - 付款逾時「不能」直接當失敗：可能其實扣款成功了 → 交給對帳查詢
 */
@Injectable()
export class CommandHandler {
  private readonly logger = new Logger(CommandHandler.name);

  constructor(
    private readonly sqs: SqsService,
    private readonly payment: PaymentAdapter,
    private readonly logistics: LogisticsAdapter,
    private readonly clinic: ClinicAdapter,
    private readonly line: LineAdapter,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async handle(cmd: Envelope<any>, receiveCount: number): Promise<void> {
    const p = cmd.payload;
    const emit = (type: string, payload: Record<string, unknown>, idKey: string) =>
      this.sqs.publish(EVENTS_QUEUE, envelope(type, payload, {
        eventId: deterministicId(idKey), correlationId: cmd.correlation_id, causationId: cmd.event_id, projectCode: cmd.project_code,
      }));

    switch (cmd.type) {
      case 'payment.requested': {
        // 記下 order → correlation，webhook 回來時才能串回同一條追蹤
        await this.redis.set(`corr:order:${p.order_no}`, cmd.correlation_id, 'EX', 86400);
        // 客人按下結帳的時間：出貨交給物流時算整筆花多久（core 放在指令裡；排程續訂沒有）
        if (p.requested_at_ms) await this.redis.set(`t0:order:${p.order_no}`, String(p.requested_at_ms), 'EX', 86400);
        try {
          const { data } = await this.payment.charge({
            order_no: p.order_no, amount: p.amount, idempotency_key: p.idempotency_key, merchant_id: p.merchant_id, payment_token_ref: p.payment_token_ref,
            ...(p.capture_mode === 'manual' ? { capture: 'manual' as const } : {}),
          });
          // 告訴 core「金流已經收下這筆了」：core 從這時才開始對帳計時（還在佇列裡排隊的不問）
          await emit('payment.submitted', { order_no: p.order_no, provider_txn_id: (data as any).charge_id }, `payment.submitted:${p.order_no}`);
        } catch (e) {
          if (e instanceof PartnerRejectedError) {
            this.logger.log({ order_no: p.order_no, status: e.status }, 'charge rejected → payment.failed');
            return emit('payment.failed', { order_no: p.order_no, reason: `rejected_${e.status}` }, `payment.failed:${p.order_no}`);
          }
          throw e; // 暫時性錯誤：讓 SQS 重送（冪等鍵保證不會重複扣款）
        }
        return; // 結果等 webhook
      }

      case 'payment.reconcile.requested': {
        // 對帳：webhook 沒來時主動查
        try {
          const { data } = await this.payment.findByOrder(p.order_no);
          if (data.status === 'succeeded') {
            return emit('payment.succeeded', { order_no: p.order_no, provider_txn_id: data.charge_id, amount: data.amount, via: 'reconcile' }, `payment.succeeded:${p.order_no}`);
          }
          if (data.status === 'authorized') {
            return emit('payment.authorized', { order_no: p.order_no, provider_txn_id: data.charge_id, amount: data.amount, via: 'reconcile' }, `payment.authorized:${p.order_no}`);
          }
          if (data.status === 'voided') {
            return emit('payment.voided', { order_no: p.order_no, via: 'reconcile' }, `payment.voided:${p.order_no}`);
          }
          if (data.status === 'failed') {
            return emit('payment.failed', { order_no: p.order_no, reason: 'declined', via: 'reconcile' }, `payment.failed:${p.order_no}`);
          }
          return; // 還在處理中
        } catch (e) {
          if (e instanceof PartnerRejectedError && e.status === 404) {
            // 查不到「不等於」沒扣款：扣款請求可能還在 SQS 裡重試（混沌測試抓到的 bug）
            // 只有超過付款期限（> SQS 重試窗口）才判定失敗；期限內就繼續等下一輪對帳
            if (p.expired) {
              this.logger.warn({ order_no: p.order_no }, 'reconcile: charge not found after expiry → payment.failed');
              return emit('payment.failed', { order_no: p.order_no, reason: 'charge_not_found_after_expiry', via: 'reconcile' }, `payment.failed:${p.order_no}`);
            }
            this.logger.debug({ order_no: p.order_no }, 'reconcile: charge not found yet (request may still be retrying), wait for next round');
            return;
          }
          throw e;
        }
      }

      case 'refund.requested': {
        try {
          await this.payment.refund({ charge_id: p.provider_txn_id, amount: p.amount, idempotency_key: p.idempotency_key, refund_id: p.refund_id });
        } catch (e) {
          if (e instanceof PartnerRejectedError) {
            return emit('refund.failed', { refund_id: p.refund_id, reason: `rejected_${e.status}` }, `refund.failed:${p.refund_id}`);
          }
          throw e;
        }
        return; // 結果等 webhook
      }

      case 'shipment.requested': {
        await this.redis.set(`shipment:${p.shipment_id}`, JSON.stringify({ order_no: p.order_no ?? null, seq: p.package_seq ?? 1, corr: cmd.correlation_id }), 'EX', 7 * 86400);
        await this.logistics.createShipment({ shipment_id: p.shipment_id, carrier: p.carrier, shipping_class: p.shipping_class, items: p.items });
        // 整筆訂單的終點：交給物流（不等物流送達）。getdel：分成好幾個包裹時只算第一個
        const requestedAt = p.order_no ? await this.redis.getdel(`t0:order:${p.order_no}`) : null;
        if (requestedAt) orderLifecycle(Number(requestedAt));
        return; // 狀態等 webhook
      }

      // ── 預約 TCC（§6.4.1）：保留（Try）是 core 同步呼叫 internal API；這裡處理確認、請款、取消 ──
      case 'booking.confirm.requested': {
        try {
          const { data } = await this.clinic.confirm(p.hold_id, p.booking_id);
          await emit('booking.confirmed', { booking_id: p.booking_id, provider_booking_id: data.provider_booking_id }, `booking:${p.booking_id}`);
          void this.notify(`order-${p.order_no}`, `健康檢查預約成功：${p.appointment_at}`);
        } catch (e) {
          // 410 保留過期／4xx：確定失敗。5xx、逾時：「不能」判定失敗 —— 醫院可能已經確認、只是回應丟了，
          // 所以讓 SQS 重送（confirm 是冪等的，重試會拿到同一個預約編號）；第 4 次還不行才放棄（core 會取消授權並釋放時段）
          if (e instanceof PartnerRejectedError || receiveCount >= 4) {
            const reason = e instanceof PartnerRejectedError ? (e.body as any)?.error ?? `rejected_${e.status}` : 'clinic_unavailable';
            this.logger.warn({ booking_id: p.booking_id, hold_id: p.hold_id, reason, receive_count: receiveCount }, 'booking confirm gave up → booking.failed (core will void + release)');
            return emit('booking.failed', { booking_id: p.booking_id, reason }, `booking:${p.booking_id}`);
          }
          throw e;
        }
        return;
      }

      case 'payment.capture.requested': {
        // 醫院確認後才請款。409（已取消授權）不該發生 → 丟例外進 DLQ 讓人看，不自動處理
        const { data } = await this.payment.capture(p.provider_txn_id);
        return emit('payment.succeeded', { order_no: p.order_no, provider_txn_id: data.charge_id, amount: data.amount, via: 'capture' }, `payment.succeeded:${p.order_no}`);
      }

      case 'payment.void.requested': {
        await this.payment.void(p.provider_txn_id);
        return emit('payment.voided', { order_no: p.order_no }, `payment.voided:${p.order_no}`);
      }

      case 'booking.release.requested': {
        // 釋放時段：best-effort（就算一直失敗，醫院的保留也會自己過期）
        try {
          await this.clinic.release(p.hold_id);
        } catch (e) {
          if (e instanceof PartnerRejectedError) return;
          throw e;
        }
        return;
      }

      case 'notification.requested':
        await this.notify(p.to, p.message);
        return;

      default:
        this.logger.warn(`unknown command ${cmd.type}, dropped`);
    }
  }

  /** LINE 通知：best-effort，失敗只記 log，不影響主流程 */
  async notify(to: string, message: string): Promise<void> {
    try {
      await this.line.push(to, message);
    } catch (e) {
      this.logger.warn(`line push failed: ${(e as Error).message}`);
    }
  }
}
