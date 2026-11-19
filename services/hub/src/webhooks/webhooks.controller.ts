import { Body, Controller, HttpCode, Inject, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { Redis } from 'ioredis';
import { deterministicId, envelope } from '../common/envelope.js';
import { handled, metrics } from '../common/metrics.js';
import { CommandHandler, EVENTS_QUEUE } from '../commands/command-handler.service.js';
import { REDIS } from '../messaging/redis.provider.js';
import { SqsService } from '../messaging/sqs.service.js';
import { WebhookSignatureGuard } from './webhook-signature.guard.js';

/**
 * NestJS 觀念：Controller＋路由裝飾器。
 *   @Controller('webhooks') + @Post(':provider') → POST /webhooks/mockpay
 *   @UseGuards(...)：進來前先過簽章驗證
 *   @Param、@Body：從請求取值
 *
 * 流程（§7 C2）：驗簽 → 去重 → 翻譯成 core 的事件 → 送 SQS → 立刻回 200（處理交給 core-worker）
 */
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly sqs: SqsService,
    private readonly commands: CommandHandler,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Post(':provider')
  @UseGuards(WebhookSignatureGuard)
  @HttpCode(200)
  async receive(@Param('provider') provider: string, @Body() body: Record<string, any>) {
    const started = Date.now();
    // 第一層去重：同一個廠商事件 24 小時內只收一次（第二層是 core 的 inbox）
    const dedupeKey = `wh:${provider}:${body.event_id}`;
    if (!(await this.redis.set(dedupeKey, '1', 'EX', 86400, 'NX'))) {
      metrics.increment('demo.webhook.duplicate', 1, { provider });
      this.logger.log({ provider, event_id: body.event_id, type: body.type, order_no: body.order_no }, 'webhook duplicate, ignored (dedupe layer 1)');
      return { ok: true, duplicate: true };
    }

    try {
      const event = await this.translate(provider, body);
      if (event) await this.sqs.publish(EVENTS_QUEUE, event);
      this.logger.debug({ provider, event_id: body.event_id, type: body.type, order_no: body.order_no, correlation_id: event?.correlation_id, forwarded: event?.type ?? null },
        `webhook ${provider} ${body.type} accepted`);
    } catch (e) {
      await this.redis.del(dedupeKey); // 沒送成功 → 釋放去重鍵，讓廠商重試時能再處理
      throw e;                          // 回 500 → 廠商會重送
    }
    handled(`hub.webhook.${provider}.${body.type}`, started);   // 處理時間：收到 → 送進 integration-events
    return { ok: true };
  }

  private async translate(provider: string, b: Record<string, any>) {
    if (provider === 'mockpay') {
      const corr = b.order_no ? await this.redis.get(`corr:order:${b.order_no}`) : null;
      const opts = (key: string) => ({ eventId: deterministicId(key), correlationId: corr ?? undefined });
      switch (b.type) {
        case 'charge.succeeded':
          return envelope('payment.succeeded', { order_no: b.order_no, provider_txn_id: b.charge_id, amount: b.amount, via: 'webhook' }, opts(`payment.succeeded:${b.order_no}`));
        case 'charge.authorized': // 預約：只授權，等醫院確認後才請款
          return envelope('payment.authorized', { order_no: b.order_no, provider_txn_id: b.charge_id, amount: b.amount, via: 'webhook' }, opts(`payment.authorized:${b.order_no}`));
        case 'charge.failed':
          return envelope('payment.failed', { order_no: b.order_no, reason: b.reason ?? 'declined', via: 'webhook' }, opts(`payment.failed:${b.order_no}`));
        case 'refund.succeeded':
          return envelope('refund.succeeded', { refund_id: b.refund_id, provider_refund_id: b.provider_refund_id }, opts(`refund.succeeded:${b.refund_id}`));
      }
    }

    if (provider === 'mocklogi' && b.type === 'shipment.status') {
      const meta = JSON.parse((await this.redis.get(`shipment:${b.shipment_id}`)) ?? '{}');
      if (meta.order_no) void this.commands.notify(`order-${meta.order_no}`, `包裹 ${meta.seq}：${statusLabel(b.status)}（${b.tracking_no}）`);
      return envelope('shipment.status_changed', {
        shipment_id: b.shipment_id, status: b.status, occurred_at: b.status_at,
        provider_event_id: b.provider_event_id, tracking_no: b.tracking_no,
      }, { eventId: deterministicId(`shipment:${b.provider_event_id}`), correlationId: meta.corr });
    }

    this.logger.warn(`unhandled webhook ${provider} ${b.type}`);
    return null;
  }
}

const statusLabel = (s: string) => ({ PICKED_UP: '已收件', IN_TRANSIT: '配送中', DELIVERED: '已送達' } as Record<string, string>)[s] ?? s;
