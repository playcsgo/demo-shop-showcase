import type { Pool, RowDataPacket } from 'mysql2/promise';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { verifyPassword } from '../auth/password.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

let db: Pool;
beforeAll(() => {
  db = testDb();
});
afterAll(() => db.end());
beforeEach(() => truncate(db));

describe('migration 和種子資料', () => {
  it('migration 從空的資料庫跑過一次，再跑不會重複', async () => {
    expect(await migrate(testEnv)).toEqual([]);
  });

  it('種子帳號可重複執行，密碼是 0204；只有員工，客戶帳號在商店', async () => {
    await seed(db, testEnv);
    await seed(db, testEnv);
    const [staff] = await db.query<RowDataPacket[]>(
      'SELECT email, role, password_hash FROM staff ORDER BY email',
    );
    expect(staff.map(({ email, role }) => ({ email, role }))).toEqual([
      { email: 'support@example.test', role: 'support_agent' },
      { email: 'vet@example.test', role: 'vet' },
    ]);
    expect(await verifyPassword('0204', staff[0].password_hash)).toBe(true);
    expect(await verifyPassword('0205', staff[0].password_hash)).toBe(false);
  });

  it('商品和訂單不在 support：資料表已經拿掉（AIC-014）', async () => {
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('products', 'orders', 'refunds', 'shipments', 'customers')",
    );
    expect(rows).toEqual([]);
  });

  it('production 拒絕放 demo 帳號', async () => {
    await expect(seed(db, { NODE_ENV: 'production' })).rejects.toThrow(
      'production',
    );
  });
});
