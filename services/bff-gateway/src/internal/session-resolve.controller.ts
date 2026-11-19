import { Body, Controller, Headers, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { SessionService } from '../auth/session.service.js';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * AI 客服（support）用（AIC-015）：瀏覽器打 support 時會帶商店的 sid cookie（同網域），support 拿它來問「這是哪位客戶」。
 * sid 放 body 不放網址（網址會進 access log）；只回 id、名字、email，不回 core 的 JWT：support 查資料用自己的服務金鑰。
 * 不在 /api 底下：storefront 的 proxy 只轉 /api，瀏覽器打不到這裡。
 */
@Controller('internal/session')
export class SessionResolveController {
  private readonly key: string;

  constructor(@Inject(SessionService) private readonly sessions: SessionService, @Inject(ConfigService) config: ConfigService) {
    this.key = config.get<string>('SUPPORT_SERVICE_KEY') ?? '';
  }

  @Post('resolve')
  @HttpCode(200)
  async resolve(@Headers('x-service-key') key: string | undefined, @Body() body: { sid?: unknown }) {
    if (!this.key || !same(this.key, key ?? '')) throw new UnauthorizedException({ error: 'invalid_service_key' });
    const sid = typeof body?.sid === 'string' && body.sid.length <= 100 ? body.sid : undefined;
    const session = sid ? await this.sessions.get(sid) : null;
    return session
      ? { valid: true, customer_id: session.customerId, name: session.name, email: session.email }
      : { valid: false };
  }
}
