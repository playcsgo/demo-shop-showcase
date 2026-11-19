import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true }); // 指定 Express，才有 app.set()
  app.useLogger(app.get(Logger)); // Nest 的 Logger 全部改走 pino（JSON）
  app.use(cookieParser());
  app.set('trust proxy', 1);  // 前面有 nginx／ALB
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
