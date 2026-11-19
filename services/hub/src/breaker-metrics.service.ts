import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { metrics } from './common/metrics.js';
import { ClinicAdapter, LineAdapter, LogisticsAdapter, PaymentAdapter } from './partners/adapters.js';

/** 每 10 秒回報各廠商斷路器狀態 → Datadog 儀表板上看得到「金流斷開 → 自動恢復」 */
@Injectable()
export class BreakerMetricsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly payment: PaymentAdapter,
    private readonly logistics: LogisticsAdapter,
    private readonly clinic: ClinicAdapter,
    private readonly line: LineAdapter,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.report(), 10_000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  report() {
    for (const http of [this.payment.http, this.logistics.http, this.clinic.http, this.clinic.sync, this.line.http]) {
      const { name, state, failures } = http.breaker.snapshot();
      metrics.gauge('demo.breaker.open', state === 'CLOSED' ? 0 : 1, { partner: name, state });
      metrics.gauge('demo.breaker.failures', failures, { partner: name });
    }
  }
}
