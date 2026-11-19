import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { DB } from '../db/database.js';

/**
 * 工具呼叫的稽核紀錄。放在 AI 層之外：tools/ 依架構規則碰不到資料庫，
 * 只能透過這裡寫紀錄。完整內容只進資料庫，不進 log（AC-26）
 */
@Injectable()
export class ToolCallLog {
  constructor(@Inject(DB) private readonly db: Pool) {}

  async record(entry: {
    runId: string;
    tool: string;
    agentId: number | null;
    args: unknown;
    result: unknown;
    status: string;
    durationMs: number;
  }) {
    await this.db.query(
      'INSERT INTO tool_calls (id, run_id, tool, agent_id, args_json, result_json, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        entry.runId,
        entry.tool,
        entry.agentId,
        JSON.stringify(entry.args ?? {}),
        JSON.stringify(entry.result ?? null),
        entry.status,
        entry.durationMs,
      ],
    );
  }
}
