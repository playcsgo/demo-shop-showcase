import { Controller, Get } from '@nestjs/common';
import { PartnerHttp } from './common/resilience/partner-http.js';
import { TIME_SCALE } from './common/time.js';
import { CommandConsumer } from './commands/command-consumer.service.js';
import { ClinicAdapter, LineAdapter, LogisticsAdapter, PaymentAdapter } from './partners/adapters.js';

/** 健康檢查＋各廠商斷路器狀態（K8s readiness、Datadog、demo 現場都看這裡） */
@Controller('health')
export class HealthController {
  constructor(
    private readonly payment: PaymentAdapter,
    private readonly logistics: LogisticsAdapter,
    private readonly clinic: ClinicAdapter,
    private readonly line: LineAdapter,
    private readonly consumer: CommandConsumer,
  ) {}

  @Get()
  check() {
    return {
      ok: true,
      breakers: [this.payment.http, this.logistics.http, this.clinic.http, this.clinic.sync, this.line.http].map((h) => h.breaker.snapshot()),
      // sandbox 的時間檢查用：壓縮後各廠商的逾時
      time_scale: TIME_SCALE,
      // 每條佇列的池子：用了幾個位子、處理了幾則（壓測時看哪個廠商塞住）
      pools: this.consumer.stats(),
      timeouts_ms: Object.fromEntries(PartnerHttp.all.map((h) => [h.name, h.opts.timeoutMs])),
    };
  }
}
