import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service.js';
import { type ApproveResult, ProposalService } from './proposal.service.js';

/** 核准走 HTTP：要明確的回應、權限檢查和錯誤訊息 */
@Controller('api/console')
export class ProposalController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ProposalService) private readonly proposals: ProposalService,
  ) {}

  private async staff(req: Request) {
    const who = await this.auth.staffFromCookies(req.headers.cookie);
    if (!who) throw new UnauthorizedException();
    return who.staff;
  }

  @Post('proposals/:id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Req() req: Request) {
    return reply(await this.proposals.approve(id, await this.staff(req)));
  }

  @Post('proposals/:id/reject')
  @HttpCode(200)
  async reject(@Param('id') id: string, @Req() req: Request) {
    return reply(await this.proposals.reject(id, await this.staff(req)));
  }

  @Get('conversations/:id/proposals')
  async list(@Param('id') id: string, @Req() req: Request) {
    const rows = await this.proposals.list(id, await this.staff(req));
    if (!rows) throw new ForbiddenException();
    return rows;
  }
}

function reply(r: ApproveResult) {
  if (r.status === 'forbidden') throw new ForbiddenException();
  if (r.status === 'not_found') throw new NotFoundException();
  if (r.status === 'error')
    throw new HttpException(
      { status: 'approving', message: '執行途中出錯，稍後再試；不會重複退款' },
      503,
    );
  if (r.status === 'rejected_by_shop') throw new HttpException(r, 409); // AC-13：錯誤訊息回到控制台
  return r;
}
