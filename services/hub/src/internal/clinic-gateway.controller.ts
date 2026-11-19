import { Body, Controller, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';
import { PartnerRejectedError } from '../common/resilience/partner-http.js';
import { ClinicAdapter } from '../partners/adapters.js';
import { InternalKeyGuard } from './internal-key.guard.js';

/**
 * core 用的同步 API（TCC 的 Try，§6.4.1）：顧客選時段時要當場知道結果，所以不能走 SQS。
 * 醫院的 4xx（額滿、時段不合法）原樣轉給 core；暫時性錯誤、斷路器打開 → 503 clinic_unavailable。
 */
@Controller('internal/clinic')
@UseGuards(InternalKeyGuard)
export class ClinicGatewayController {
  constructor(private readonly clinic: ClinicAdapter) {}

  @Post('holds')
  @HttpCode(201)
  hold(@Body() body: { hold_key: string; start_at: string; service_type: string }) {
    return this.call(() => this.clinic.hold(body));
  }

  private async call<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    try {
      return (await fn()).data;
    } catch (e) {
      if (e instanceof PartnerRejectedError) throw new HttpException(e.body as object, e.status);
      throw new HttpException({ error: 'clinic_unavailable' }, 503);
    }
  }
}
