import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { DB } from '../db/database.js';

/** AI 每次執行的紀錄。放在 AI 層之外，理由同 tool-call-log.ts */
@Injectable()
export class AiRunLog {
  constructor(@Inject(DB) private readonly db: Pool) {}

  async start(run: {
    id: string;
    conversationId: string;
    kind: string;
    actor: 'customer' | 'agent';
    agentId: number | null;
    tier: string;
  }) {
    await this.db.query(
      "INSERT INTO ai_runs (id, conversation_id, kind, actor, agent_id, model_tier, status) VALUES (?, ?, ?, ?, ?, ?, 'running')",
      [run.id, run.conversationId, run.kind, run.actor, run.agentId, run.tier],
    );
  }

  async finish(
    id: string,
    result: {
      status: 'done' | 'cancelled' | 'error';
      errorCode?: string;
      decision?: unknown;
      ttftMs?: number | null;
      totalMs?: number;
    },
  ) {
    await this.db.query(
      'UPDATE ai_runs SET status = ?, error_code = ?, decision_json = ?, ttft_ms = ?, total_ms = ? WHERE id = ?',
      [
        result.status,
        result.errorCode ?? null,
        result.decision === undefined ? null : JSON.stringify(result.decision),
        result.ttftMs ?? null,
        result.totalMs ?? null,
        id,
      ],
    );
  }
}
