import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Put, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Redis } from 'ioredis';
import { REDIS } from '../common/redis.provider.js';
import { CoreClient } from '../core/core-client.service.js';
import { CorrelationId, CurrentSession, SessionGuard } from '../auth/session.guard.js';
import type { Session } from '../auth/session.service.js'; // interface 用在裝飾器參數上 → 要用 import type
import { SessionService } from '../auth/session.service.js';

/**
 * 前台用的 API：大多是「帶上伺服器端的 JWT，轉給 core」。
 * 前台只認 BFF（同網域 /api），不知道 core 在哪、也拿不到 token。
 */
@Controller('api')
export class ShopController {
  constructor(
    private readonly core: CoreClient,
    private readonly sessions: SessionService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** 商品目錄：人人相同 → BFF 再快取 30 秒（core 那邊還有 Redis 5 分鐘）。價格以結帳時 core 重算為準 */
  @Get('catalog')
  async catalog(@CorrelationId() corr: string) {
    const cached = await this.redis.get('bff:catalog');
    if (cached) return JSON.parse(cached);
    const data = CoreClient.unwrap(await this.core.call('/catalog', { correlationId: corr }));
    await this.redis.set('bff:catalog', JSON.stringify(data), 'EX', 30);
    return data;
  }

  @Get('cart')
  @UseGuards(SessionGuard)
  async cart(@CurrentSession() s: Session, @CorrelationId() corr: string) {
    return this.forward(s, corr, '/cart');
  }

  @Put('cart/items')
  @UseGuards(SessionGuard)
  async putItem(@CurrentSession() s: Session, @CorrelationId() corr: string, @Body() body: unknown) {
    return this.forward(s, corr, '/cart/items', { method: 'PUT', body });
  }

  @Delete('cart/items/:id')
  @UseGuards(SessionGuard)
  async removeItem(@CurrentSession() s: Session, @CorrelationId() corr: string, @Param('id') id: string) {
    return this.forward(s, corr, `/cart/items/${Number(id)}`, { method: 'DELETE' });
  }

  /** 結帳：Idempotency-Key 由前台產生（每次按「結帳」前產生一次），BFF 原樣轉給 core */
  @Post('checkout')
  @UseGuards(SessionGuard)
  @HttpCode(201)
  async checkout(@CurrentSession() s: Session, @CorrelationId() corr: string, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    if (!key) throw new BadRequestException({ error: 'idempotency_key_required' });
    const r = await this.core.call('/checkout', {
      method: 'POST', body, token: await this.sessions.freshToken(s, corr), correlationId: corr, headers: { 'idempotency-key': key },
    });
    res.status(r.status);
    return CoreClient.unwrap(r);
  }

  @Get('orders')
  @UseGuards(SessionGuard)
  async orders(@CurrentSession() s: Session, @CorrelationId() corr: string) {
    return this.forward(s, corr, '/orders');
  }

  @Get('orders/:orderNo')
  @UseGuards(SessionGuard)
  async order(@CurrentSession() s: Session, @CorrelationId() corr: string, @Param('orderNo') orderNo: string) {
    return this.forward(s, corr, `/orders/${encodeURIComponent(orderNo)}`);
  }

  @Get('warehouse')
  @UseGuards(SessionGuard)
  async warehouse(@CurrentSession() s: Session, @CorrelationId() corr: string) {
    return this.forward(s, corr, '/warehouse');
  }

  @Post('warehouse/withdrawals')
  @UseGuards(SessionGuard)
  async withdraw(@CurrentSession() s: Session, @CorrelationId() corr: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    if (!key) throw new BadRequestException({ error: 'idempotency_key_required' });
    return this.forward(s, corr, '/warehouse/withdrawals', { method: 'POST', body, headers: { 'idempotency-key': key } });
  }

  @Get('subscriptions')
  @UseGuards(SessionGuard)
  async subscriptions(@CurrentSession() s: Session, @CorrelationId() corr: string) {
    return this.forward(s, corr, '/subscriptions');
  }

  private async forward(s: Session, corr: string, path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    return CoreClient.unwrap(await this.core.call(path, { ...opts, token: await this.sessions.freshToken(s, corr), correlationId: corr }));
  }
}
