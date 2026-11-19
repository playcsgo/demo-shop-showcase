import { createConnection } from 'mysql2/promise';
import { dbOptions } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { testEnv } from './db.js';

// 每次都從空的資料庫跑 migration：migration 本身也一起被測到
export default async function setup() {
  const conn = await createConnection({
    ...dbOptions(testEnv),
    database: undefined,
  });
  await conn.query('DROP DATABASE IF EXISTS support_test');
  await conn.query(
    'CREATE DATABASE support_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
  );
  await conn.end();
  await migrate(testEnv);
}
