import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { correlation } from './common/correlation.js';

async function bootstrap() {
  // rawBody：webhook 驗簽要用原始 body
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  app.useLogger(app.get(Logger)); // Nest 的 Logger 全部改走 pino（JSON）
  // 最外層：決定這個請求的 correlation_id（沿用上游帶來的，沒有就產生）並寫回 header，
  // 後面的 pino-http 會讀到同一個；整個請求期間呼叫廠商時都帶上它（common/correlation.ts）
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const id = String(req.headers['x-correlation-id'] ?? '').slice(0, 64) || randomUUID();
    req.headers['x-correlation-id'] = id;
    correlation.run(id, next);
  });
  app.enableShutdownHooks(); // 收到 SIGTERM 時呼叫 onApplicationShutdown（停止輪詢、優雅結束）
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
