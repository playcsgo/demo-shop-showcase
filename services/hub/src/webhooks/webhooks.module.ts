import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [CommandsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
