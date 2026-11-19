import { createPool, type Pool, type PoolOptions } from 'mysql2/promise';

export const DB = Symbol('DB');

export function dbOptions(env: NodeJS.ProcessEnv): PoolOptions {
  return {
    host: env.DB_HOST ?? 'support-mysql',
    port: Number(env.DB_PORT ?? 3306),
    user: env.DB_USER ?? 'support',
    password: env.DB_PASSWORD ?? 'support',
    database: env.DB_NAME ?? 'support',
    timezone: 'Z', // 時間一律 UTC，顯示時才轉時區
    dateStrings: false,
    decimalNumbers: true, // DECIMAL 預設回字串，餵食量要拿來比較和顯示
    connectionLimit: 10,
  };
}

export const createDb = (env: NodeJS.ProcessEnv): Pool =>
  createPool(dbOptions(env));
