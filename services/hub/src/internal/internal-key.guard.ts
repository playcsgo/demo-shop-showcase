import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

/** 只給 core 呼叫的內部 API：比對 x-internal-key（服務間共用金鑰；上雲改走內網＋IAM／mTLS） */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.get<string>('INTERNAL_API_KEY') ?? 'local-internal-key');
  }

  canActivate(ctx: ExecutionContext): boolean {
    const got = Buffer.from(String(ctx.switchToHttp().getRequest().headers['x-internal-key'] ?? ''));
    if (got.length !== this.key.length || !timingSafeEqual(got, this.key)) throw new UnauthorizedException({ error: 'invalid_internal_key' });
    return true;
  }
}
