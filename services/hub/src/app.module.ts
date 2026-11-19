import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loggingModule } from './common/logging.js';
import { BreakerMetricsService } from './breaker-metrics.service.js';
import { CommandsModule } from './commands/commands.module.js';
import { HealthController } from './health.controller.js';
import { ClinicGatewayController } from './internal/clinic-gateway.controller.js';
import { LogisticsGatewayController } from './internal/logistics-gateway.controller.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { PartnersModule } from './partners/partners.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

/**
 * 根模組：把各功能模組組起來。
 *   ConfigModule：讀環境變數（ConfigService）
 *   MessagingModule：SQS、Redis（@Global）
 *   PartnersModule：外部廠商 adapter
 *   CommandsModule：消費 core-commands
 *   WebhooksModule：接收廠商 callback
 *   BreakerMetricsService：斷路器狀態 → Datadog
 *   ClinicGatewayController：core 用的同步內部 API（醫院保留時段）
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), loggingModule, MessagingModule, PartnersModule, CommandsModule, WebhooksModule],
  controllers: [HealthController, ClinicGatewayController, LogisticsGatewayController],
  providers: [BreakerMetricsService],
})
export class AppModule {}
