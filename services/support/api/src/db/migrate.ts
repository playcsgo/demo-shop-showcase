import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'mysql2/promise';
import { dbOptions } from './database.js';

// 以工作目錄為準：原始碼和 build 之後的位置不同
const DIR = join(process.cwd(), 'migrations');

/** 依檔名順序執行還沒跑過的 SQL；可重複執行 */
export async function migrate(env: NodeJS.ProcessEnv): Promise<string[]> {
  // 只有 migration 允許一次多句 SQL
  const conn = await createConnection({
    ...dbOptions(env),
    multipleStatements: true,
  });
  try {
    await conn.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(100) PRIMARY KEY, ran_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))',
    );
    const [rows] = await conn.query('SELECT name FROM schema_migrations');
    const done = new Set((rows as { name: string }[]).map((r) => r.name));
    const ran: string[] = [];
    for (const file of (await readdir(DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      if (done.has(file)) continue;
      await conn.query(await readFile(join(DIR, file), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [
        file,
      ]);
      ran.push(file);
    }
    return ran;
  } finally {
    await conn.end();
  }
}
