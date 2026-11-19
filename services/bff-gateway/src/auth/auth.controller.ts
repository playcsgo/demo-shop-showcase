import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CoreClient } from '../core/core-client.service.js';
import { JwksService } from './jwks.service.js';
import { CorrelationId, CurrentSession, SESSION_COOKIE, SessionGuard } from './session.guard.js';
import type { Session } from './session.service.js'; // interface 用在裝飾器參數上 → 要用 import type
import { SessionService } from './session.service.js';

@Controller('api')
export class AuthController {
  private readonly secureCookie: boolean;

  constructor(
    private readonly core: CoreClient,
    private readonly jwks: JwksService,
    private readonly sessions: SessionService,
    config: ConfigService,
  ) {
    this.secureCookie = config.get('COOKIE_SECURE') === '1';
  }

  /** 登入：core 驗密碼並簽 JWT → BFF 用 JWKS 驗章 → 存進 session → 瀏覽器只拿到 httpOnly cookie */
  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: { email: string; password: string }, @Res({ passthrough: true }) res: Response, @CorrelationId() corr: string) {
    const data = CoreClient.unwrap(await this.core.call<any>('/auth/login', { method: 'POST', body, correlationId: corr }));
    const claims = await this.jwks.verify(data.access_token);

    const session = await this.sessions.create({
      customerId: Number(claims.sub), name: data.customer.name, email: data.customer.email,
      token: data.access_token, tokenExp: claims.exp!,
    });

    res.cookie(SESSION_COOKIE, session.sid, {
      httpOnly: true,           // JavaScript 讀不到（document.cookie 看不到）
      sameSite: 'lax',          // 跨站的表單 POST 不會帶 → 防 CSRF
      secure: this.secureCookie, // 正式環境（HTTPS）要開
      path: '/',
      maxAge: 7 * 86400 * 1000,
    });
    return { name: session.name, email: session.email }; // 回應裡沒有任何 token
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) await this.sessions.destroy(sid);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentSession() s: Session) {
    return { name: s.name, email: s.email };
  }
}
