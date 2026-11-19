import { Controller, Get, HttpException, Query, UseGuards } from '@nestjs/common';
import { PartnerRejectedError } from '../common/resilience/partner-http.js';
import { LogisticsAdapter } from '../partners/adapters.js';
import { InternalKeyGuard } from './internal-key.guard.js';

/**
 * core 用的同步 API（AIC-017）：AI 客服問「多久會到」時，core-api 經這裡問物流商的預估。
 * 物流商的 4xx 原樣轉給 core；暫時性錯誤、斷路器打開 → 503 logistics_unavailable（不給假的預估）
 */
@Controller('internal/logistics')
@UseGuards(InternalKeyGuard)
export class LogisticsGatewayController {
  constructor(private readonly logistics: LogisticsAdapter) {}

  @Get('estimate')
  async estimate(@Query('shipping_class') shippingClass: string) {
    try {
      return (await this.logistics.estimate(shippingClass ?? '')).data;
    } catch (e) {
      if (e instanceof PartnerRejectedError) throw new HttpException(e.body as object, e.status);
      throw new HttpException({ error: 'logistics_unavailable' }, 503);
    }
  }
}
