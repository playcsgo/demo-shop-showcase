import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service.js';
import { type DemoSettings, PARTNERS_DEMO, type PartnersDemo } from './partners-demo.js';

/** demo 面板：切 partners（假物流商）的兩個開關（AIC-017）。只有登入的員工能用；訂單在商店下（AIC-014） */
@Controller('api/console/demo')
export class DemoController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PARTNERS_DEMO) private readonly partners: PartnersDemo,
  ) {}

  private async staff(req: Request) {
    const who = await this.auth.staffFromCookies(req.headers.cookie);
    if (!who) throw new UnauthorizedException();
    return who.staff;
  }

  @Get()
  async settings(@Req() req: Request) {
    await this.staff(req);
    return this.partners.settings();
  }

  @Post('settings')
  @HttpCode(200)
  async update(@Body() body: unknown, @Req() req: Request) {
    await this.staff(req);
    const { support_demo, logistics_down } = (body ?? {}) as Record<
      string,
      unknown
    >;
    const changes = Object.fromEntries(
      Object.entries({ support_demo, logistics_down }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    if (Object.values(changes).some((v) => v !== 'on' && v !== 'off'))
      throw new BadRequestException('只能是 on 或 off');
    return this.partners.update(changes as Partial<DemoSettings>);
  }
}
