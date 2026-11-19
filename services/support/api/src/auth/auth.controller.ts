import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { clientIp } from '../common/client-ip.js';
import { FixedWindowLimiter } from '../common/rate-limit.js';
import { trustedProxies } from '../common/trusted-proxies.js';
import { ENV } from '../env.js';
import { AuthService } from './auth.service.js';
import {
  clearCookie,
  CUSTOMER_COOKIE,
  setCookie,
  STAFF_COOKIE,
} from './cookies.js';
import { SessionService } from './session.service.js';

const WRONG = '帳號或密碼錯誤';

function credentials(body: unknown): { email: string; password: string } {
  const { email, password } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    email.length > 255 ||
    password.length > 200
  ) {
    throw new BadRequestException('需要 email 和 password');
  }
  return { email, password };
}

@Controller('api/auth')
export class AuthController {
  private readonly anonymousPerIp = new FixedWindowLimiter(20, 60_000);
  private readonly proxies: () => Promise<Set<string>>;

  constructor(
    @Inject(ENV) env: NodeJS.ProcessEnv,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {
    this.proxies = trustedProxies(env);
  }

  /**
   * 開或取回客戶的 session（AIC-015）：身分來自商店的登入（sid cookie），support 不收客戶密碼。
   * 沒登入商店就是匿名 session。換了身分（在商店登入、登出、換帳號）時舊的 session 已經作廢，這裡開新的：
   * 同一段對話不換身分，登入後是新的對話
   */
  @Post('customer/session')
  @HttpCode(200)
  async customerSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const current = await this.auth.customerFromCookies(req.headers.cookie);
    if (current)
      return current.customer
        ? { ...current.customer, anonymous: false }
        : { anonymous: true };
    const customer = await this.auth.shopCustomer(req.headers.cookie);
    if (customer) await this.auth.rememberCustomer(customer);
    else {
      // 匿名 session 不用帳號就拿得到，要擋同一個來源換 session 繞過訊息限流
      const ip = clientIp(
        req.socket.remoteAddress,
        String(req.headers['x-forwarded-for'] ?? '') || undefined,
        await this.proxies(),
      );
      if (!this.anonymousPerIp.hit(ip))
        throw new HttpException('太頻繁了，請稍後再試', 429);
    }
    const { token } = await this.sessions.create('customer', customer?.id ?? null);
    res.setHeader('Set-Cookie', setCookie(CUSTOMER_COOKIE, token));
    return customer ? { ...customer, anonymous: false } : { anonymous: true };
  }

  @Get('customer/me')
  async customerMe(@Req() req: Request) {
    const current = await this.auth.customerFromCookies(req.headers.cookie);
    if (!current) throw new UnauthorizedException();
    return current.customer
      ? { ...current.customer, anonymous: false }
      : { anonymous: true };
  }

  @Post('customer/logout')
  @HttpCode(200)
  async customerLogout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const current = await this.auth.customerFromCookies(req.headers.cookie);
    if (current) await this.sessions.revoke(current.session.hash);
    res.setHeader('Set-Cookie', clearCookie(CUSTOMER_COOKIE));
    return {};
  }

  @Post('staff/login')
  @HttpCode(200)
  async staffLogin(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { email, password } = credentials(body);
    const staff = await this.auth.checkStaff(email, password);
    if (!staff) throw new UnauthorizedException(WRONG);
    const previous = await this.auth.staffFromCookies(req.headers.cookie);
    if (previous) await this.sessions.revoke(previous.session.hash);
    const { token } = await this.sessions.create('staff', staff.id);
    res.setHeader('Set-Cookie', setCookie(STAFF_COOKIE, token));
    return staff;
  }

  @Get('staff/me')
  async staffMe(@Req() req: Request) {
    const current = await this.auth.staffFromCookies(req.headers.cookie);
    if (!current) throw new UnauthorizedException();
    return current.staff;
  }

  @Post('staff/logout')
  @HttpCode(200)
  async staffLogout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const current = await this.auth.staffFromCookies(req.headers.cookie);
    if (current) await this.sessions.revoke(current.session.hash);
    res.setHeader('Set-Cookie', clearCookie(STAFF_COOKIE));
    return {};
  }
}
