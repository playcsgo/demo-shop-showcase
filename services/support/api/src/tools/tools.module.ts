import { Module } from '@nestjs/common';
import { join } from 'node:path';
import { ToolCallLog } from '../audit/tool-call-log.js';
import { SopBook } from '../sop/sop.js';
import { McpController } from './mcp.controller.js';
import { RunTokenService } from './run-token.service.js';
import { ToolsService } from './tools.service.js';

@Module({
  controllers: [McpController],
  providers: [
    // 啟動時讀進記憶體並驗證：SOP 有問題就啟動失敗
    {
      provide: SopBook,
      useFactory: () => SopBook.load(join(process.cwd(), 'sop')),
    },
    { provide: RunTokenService, useFactory: () => new RunTokenService() },
    ToolsService,
    ToolCallLog,
  ],
  exports: [RunTokenService, ToolsService, SopBook],
})
export class ToolsModule {}
