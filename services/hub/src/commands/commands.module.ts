import { Module } from '@nestjs/common';
import { PartnersModule } from '../partners/partners.module.js';
import { CommandConsumer } from './command-consumer.service.js';
import { CommandHandler } from './command-handler.service.js';

@Module({
  imports: [PartnersModule], // 要注入 PaymentAdapter 等，就要 import 匯出它們的模組
  providers: [CommandHandler, CommandConsumer],
  exports: [CommandHandler, CommandConsumer],   // CommandConsumer：/health 要顯示池子的狀況
})
export class CommandsModule {}
