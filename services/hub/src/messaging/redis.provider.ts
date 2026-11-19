import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/**
 * NestJS 觀念：自訂 Provider。
 * 第三方類別（ioredis）沒有 @Injectable()，用 token＋useFactory 告訴 Nest「要怎麼建立它」，
 * 之後在任何地方 @Inject(REDIS) 就拿得到同一個連線。
 */
export const REDIS = Symbol('REDIS');

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => new Redis(config.get<string>('REDIS_URL') ?? 'redis://redis:6379/2'),
};
