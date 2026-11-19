import type { Pool } from 'mysql2/promise';
import { createDb } from '../src/db/database.js';

// 資料庫測試連 support_test，由 vitest.setup.ts 先跑 migration
export const testEnv = {
  ...process.env,
  DB_NAME: 'support_test',
  // 退款結果的輪詢（AIC-016）：測試裡不用等 3 秒
  SUPPORT_REFUND_POLL_MS: '20',
  SUPPORT_REFUND_POLL_MAX_MS: '500',
};
export const testDb = (): Pool => createDb(testEnv);

const TABLES = [
  'proposals',
  'pending_tickets',
  'handoffs',
  'tool_calls',
  'ai_runs',
  'messages',
  'conversations',
  'sessions',
  'shop_customers',
  'staff',
];

export async function truncate(db: Pool) {
  await db.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) await db.query(`TRUNCATE TABLE ${t}`);
  await db.query('SET FOREIGN_KEY_CHECKS = 1');
}
