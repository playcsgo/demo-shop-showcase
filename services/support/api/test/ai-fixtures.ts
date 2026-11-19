import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';

/** 工具呼叫要掛在一次 AI 執行底下（外鍵），測試用這個建一筆 */
export async function aiRun(
  db: Pool,
  opts: { actor?: 'customer' | 'agent'; agentId?: number | null } = {},
) {
  const conversationId = randomUUID();
  await db.query(
    "INSERT INTO conversations (id, mode, status, session_hash) VALUES (?, 'ask', 'active', REPEAT('0', 64))",
    [conversationId],
  );
  const runId = randomUUID();
  await db.query(
    "INSERT INTO ai_runs (id, conversation_id, kind, actor, agent_id, model_tier, status) VALUES (?, ?, 'ask', ?, ?, 'main', 'running')",
    [runId, conversationId, opts.actor ?? 'customer', opts.agentId ?? null],
  );
  return { runId, conversationId };
}
