import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { AuthService } from '../auth/auth.service.js';
import { ChatService } from '../chat/chat.service.js';
import { DB } from '../db/database.js';

/**
 * 追蹤面板：每次 AI 執行的判斷、工具、參數、結果、耗時，以及提案。
 * 完整內容只在資料庫，只給被指派的客服看；log 只有 ID 和耗時（AC-26）
 */
@Controller('api/console/conversations')
export class TraceController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(DB) private readonly db: Pool,
  ) {}

  @Get(':id/trace')
  async trace(@Param('id') id: string, @Req() req: Request) {
    const who = await this.auth.staffFromCookies(req.headers.cookie);
    if (!who) throw new UnauthorizedException();
    if (!(await this.chat.staffCanAccess(id, who.staff)))
      throw new ForbiddenException();
    const [runs] = await this.db.query<RowDataPacket[]>(
      'SELECT id, kind, actor, agent_id, model_tier, status, error_code, decision_json, ttft_ms, total_ms, created_at FROM ai_runs WHERE conversation_id = ? ORDER BY created_at',
      [id],
    );
    const [calls] = await this.db.query<RowDataPacket[]>(
      `SELECT t.run_id, t.tool, t.agent_id, t.args_json, t.result_json, t.status, t.duration_ms, t.created_at
         FROM tool_calls t JOIN ai_runs r ON r.id = t.run_id WHERE r.conversation_id = ? ORDER BY t.created_at`,
      [id],
    );
    const [proposals] = await this.db.query<RowDataPacket[]>(
      'SELECT * FROM proposals WHERE conversation_id = ? ORDER BY created_at',
      [id],
    );
    return {
      runs: runs.map((r) => ({
        ...r,
        tool_calls: calls.filter((c) => c.run_id === r.id),
      })),
      proposals,
    };
  }
}
