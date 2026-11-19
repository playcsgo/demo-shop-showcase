import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loggingModule } from './common/logging.js';
import { AuthController } from './auth/auth.controller.js';
import { JwksService } from './auth/jwks.service.js';
import { SessionGuard } from './auth/session.guard.js';
import { SessionService } from './auth/session.service.js';
import { CorrelationMiddleware } from './common/correlation.middleware.js';
import { redisProvider } from './common/redis.provider.js';
import { CoreClient } from './core/core-client.service.js';
import { EventsController } from './events/events.controller.js';
import { SessionResolveController } from './internal/session-resolve.controller.js';
import { OverviewController } from './shop/overview.controller.js';
import { ShopController } from './shop/shop.controller.js';

/**
 * BFF 的範圍很小，用一個模組就好（hub 分了 5 個模組是因為職責比較多）。
 * 原則：只做整合、轉發、session；不放任何業務規則（價格、庫存、訂單規則都在 core）。
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), loggingModule],
  controllers: [AuthController, ShopController, OverviewController, EventsController, SessionResolveController],
  providers: [redisProvider, CoreClient, JwksService, SessionService, SessionGuard],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
