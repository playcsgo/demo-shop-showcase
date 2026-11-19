import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AppModule } from './app.module.js';
import { allowedOrigins, originGuard } from './auth/origin.js';
import type { LlmRunner } from './llm/llm.types.js';
import type { ShopSessions } from './auth/shop-session.js';
import type { PartnersDemo } from './demo/partners-demo.js';
import type { ShopClient } from './shop/shop-client.js';

export async function createApp(
  env: NodeJS.ProcessEnv,
  opts: {
    logStream?: DestinationStream;
    llm?: LlmRunner;
    shop?: ShopClient;
    sessions?: ShopSessions;
    partners?: PartnersDemo;
  } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(
    AppModule.forRoot(env, opts.logStream, opts.llm, opts.shop, opts.sessions, opts.partners),
    {
      bufferLogs: true,
    },
  );
  app.useLogger(app.get(Logger));
  app.use(originGuard(allowedOrigins(env)));
  return app;
}
