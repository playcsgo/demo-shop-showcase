import { CanActivate, ExecutionContext, Injectable, Logger, RawBodyRequest, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * NestJS 觀念：Guard 決定「這個請求能不能進到 Controller」。
 * 這裡驗證廠商的 HMAC 簽章（§7 C2）：
 *  - 簽章 = HMAC-SHA256(secret, "時間戳記.原始 body")，偽造的 callback 算不出來
 *  - 時間戳記超過 5 分鐘 → 拒絕（防止有人錄下舊的 callback 重放）
 *  - 用原始 body（rawBody）驗，JSON 重新序列化後空白或順序不同就會對不上
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private static readonly TOLERANCE_SECONDS = 300;
  private readonly logger = new Logger(WebhookSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const provider = String(req.params.provider);
    const secret = this.config.get<string>(`${provider.toUpperCase()}_WEBHOOK_SECRET`);
    const header = req.header('x-mock-signature') ?? '';
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));

    const reject = (reason: string) => {
      this.logger.warn({ provider, reason, signed_at: parts.t }, `webhook rejected: ${reason}`); // 可能是攻擊或設定錯誤，一定要留紀錄
      return new UnauthorizedException(reason);
    };

    if (!secret || !parts.t || !parts.v1 || !req.rawBody) throw reject('missing signature');
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > WebhookSignatureGuard.TOLERANCE_SECONDS) {
      throw reject('stale signature');
    }

    const expected = createHmac('sha256', secret).update(`${parts.t}.${req.rawBody.toString('utf8')}`).digest();
    const given = Buffer.from(parts.v1, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw reject('bad signature'); // timingSafeEqual：比對時間固定，避免被用時間差猜出簽章
    }
    return true;
  }
}
