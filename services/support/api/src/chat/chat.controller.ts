import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service.js';
import { HandoffService } from '../handoff/handoff.service.js';
import { ChatRealtime } from './chat.realtime.js';
import { ChatService } from './chat.service.js';

@Controller('api/conversations')
export class ConversationController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ChatRealtime) private readonly realtime: ChatRealtime,
  ) {}

  /** 客戶 ID 只來自 session；body 只讀 mode */
  @Post()
  async start(@Body() body: unknown, @Req() req: Request) {
    const who = await this.auth.customerFromCookies(req.headers.cookie);
    if (!who) throw new UnauthorizedException();
    const mode = (body as { mode?: unknown } | null)?.mode;
    if (mode !== 'ask' && mode !== 'human')
      throw new BadRequestException('mode 只能是 ask 或 human');
    const conv = await this.chat.start(who.session, who.customer, mode);
    if (mode === 'human') this.realtime.queueChanged(conv.id);
    return { id: conv.id, mode: conv.mode, status: conv.status };
  }

  @Get(':id/messages')
  async messages(@Param('id') id: string, @Req() req: Request) {
    const who = await this.auth.customerFromCookies(req.headers.cookie);
    if (!who) throw new UnauthorizedException();
    if (!(await this.chat.customerCanAccess(id, who.session, who.customer)))
      throw new ForbiddenException();
    return this.chat.history(id, 'customer');
  }
}

@Controller('api/console')
export class ConsoleController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ChatRealtime) private readonly realtime: ChatRealtime,
    @Inject(HandoffService) private readonly handoffs: HandoffService,
  ) {}

  private async staff(req: Request) {
    const who = await this.auth.staffFromCookies(req.headers.cookie);
    if (!who) throw new UnauthorizedException();
    return who.staff;
  }

  @Get('queue')
  async queue(@Req() req: Request) {
    return this.chat.queue((await this.staff(req)).role);
  }

  @Get('conversations')
  async mine(@Req() req: Request) {
    return this.chat.assignedTo(await this.staff(req));
  }

  @Post('conversations/:id/assign')
  @HttpCode(200)
  async assign(@Param('id') id: string, @Req() req: Request) {
    if (!(await this.chat.assign(id, await this.staff(req))))
      throw new ConflictException('已經被接走，或不在你的佇列');
    this.realtime.queueChanged(id);
    return { ok: true };
  }

  /** 刪除＝結束並隱藏（AIC-019）：不是自己接手的一律 404，不透露對話存不存在 */
  @Delete('conversations/:id')
  @HttpCode(200)
  async close(@Param('id') id: string, @Req() req: Request) {
    if (!(await this.chat.close(id, await this.staff(req))))
      throw new NotFoundException();
    await this.realtime.publish(
      await this.chat.postSystem(id, '這段對話已結束。'),
    );
    return { ok: true };
  }

  @Get('conversations/:id/messages')
  async messages(@Param('id') id: string, @Req() req: Request) {
    if (!(await this.chat.staffCanAccess(id, await this.staff(req))))
      throw new ForbiddenException();
    return this.chat.history(id, 'staff');
  }

  /** AC-16、AC-17：轉接原因、摘要和「疑似套取資料」的標記，只有接手的客服看得到 */
  @Get('conversations/:id/handoff')
  async handoff(@Param('id') id: string, @Req() req: Request) {
    if (!(await this.chat.staffCanAccess(id, await this.staff(req))))
      throw new ForbiddenException();
    return (await this.handoffs.latest(id)) ?? {};
  }
}
