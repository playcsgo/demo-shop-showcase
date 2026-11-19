import type { Pool } from 'mysql2/promise';
import { hashPassword } from '../auth/password.js';

// 都是虛構的；密碼都是 0204，和經銷商服務相同
export const DEMO_STAFF = [
  ['support@example.test', '客服小美', 'support_agent'],
  ['vet@example.test', '獸醫阿哲', 'vet'],
] as const;

/** 可重複執行：已經有的帳號不動，重跑也不會把人登出。客戶帳號、商品、訂單都在商店，這裡只建員工 */
export async function seed(db: Pool, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.NODE_ENV === 'production')
    throw new Error('production 不能放 demo 帳號');
  const hash = await hashPassword('0204');
  for (const [email, name, role] of DEMO_STAFF) {
    await db.query(
      'INSERT IGNORE INTO staff (email, name, role, password_hash) VALUES (?, ?, ?, ?)',
      [email, name, role, hash],
    );
  }
}
