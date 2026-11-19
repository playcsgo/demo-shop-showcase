import { Global, Module } from '@nestjs/common';
import { redisProvider, REDIS } from './redis.provider.js';
import { SqsService } from './sqs.service.js';

/**
 * NestJS 觀念：Module 是「一組相關功能的容器」。
 *  - providers：這個模組建立的服務
 *  - exports：開放給其他模組注入的服務
 *  - @Global()：匯出的服務全站可用，其他模組不用再 import 這個模組
 */
@Global()
@Module({
  providers: [SqsService, redisProvider],
  exports: [SqsService, REDIS],
})
export class MessagingModule {}
