import { Body, Controller, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { SESSION_COOKIE } from '../auth/session.guard.js';

const ALLOWED = new Set(['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase']);

/**
 * 行為事件（§6.1）：前台用 sendBeacon 批次送來 → BFF 補上伺服器端資訊 → SQS analytics-events → 之後落地 S3／Redshift。
 * 和交易資料分開：分析事件掉了幾筆沒關係，訂單的 UTM 另外寫在 orders 表上（不依賴前端事件）。
 */
@Controller('api')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  constructor(config: ConfigService) {
    const endpoint = config.get<string>('AWS_ENDPOINT');
    this.sqs = new SQSClient({ region: config.get('AWS_DEFAULT_REGION', 'ap-northeast-1'), ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}) });
    this.queueUrl = `${config.getOrThrow<string>('SQS_PREFIX')}/analytics-events`;
  }

  @Post('events')
  @HttpCode(202)
  async collect(@Body() body: { events?: Array<Record<string, any>> }, @Req() req: Request) {
    const events = (body.events ?? []).filter((e) => ALLOWED.has(e?.name)).slice(0, 10); // SQS 一批最多 10 則
    if (events.length === 0) return { accepted: 0 };

    const sid = req.cookies?.[SESSION_COOKIE];
    const entries = events.map((e) => ({
      Id: randomUUID().replace(/-/g, '').slice(0, 20),
      MessageBody: JSON.stringify({
        ...e,
        received_at: new Date().toISOString(),
        session_hash: sid ? Buffer.from(sid).toString('base64').slice(0, 12) : null, // 不存原始 session id
        user_agent: req.header('user-agent')?.slice(0, 200),
      }),
    }));

    try {
      await this.sqs.send(new SendMessageBatchCommand({ QueueUrl: this.queueUrl, Entries: entries }));
    } catch (e) {
      this.logger.warn({ dropped: events.length, err: (e as Error).message }, 'analytics events dropped'); // 分析事件 best-effort，不影響使用者
    }
    return { accepted: events.length };
  }
}
