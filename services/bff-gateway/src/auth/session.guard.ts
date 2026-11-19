import { CanActivate, createParamDecorator, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { Session, SessionService } from './session.service.js';

export const SESSION_COOKIE = 'sid';

/**
 * Guard：沒有有效的 session cookie → 401。
 * 這是 BFF 的「粗檢查」（有沒有登入）；「這筆訂單是不是你的」由 core 判斷（§8.3），BFF 不重複實作。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { session?: Session }>();
    const session = await this.sessions.get(req.cookies?.[SESSION_COOKIE]);
    if (!session) throw new UnauthorizedException({ error: 'unauthenticated' });
    req.session = session;
    return true;
  }
}

/** NestJS 觀念：自訂參數裝飾器。controller 裡寫 @CurrentSession() s: Session 就拿得到 */
export const CurrentSession = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().session as Session);
export const CorrelationId = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().correlationId as string);
