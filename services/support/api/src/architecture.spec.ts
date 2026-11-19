import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AI_LAYER_RULES, findViolations } from './architecture.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'arch-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

describe('架構：AI 層碰不到 SQL', () => {
  it('檢查函式抓得到直接用 mysql2、db、shop 內部檔案的 import', () => {
    write('tools/a.ts', "import { createPool } from 'mysql2/promise';");
    write('ask/b.ts', "import { DB } from '../db/database.js';");
    write(
      'tools/c.ts',
      "import { importCatalog } from '../shop/import-catalog.js';",
    );
    write(
      'join/d.ts',
      "const m = await import('../shop/shop-catalog.service.js');",
    );
    write('llm/e.ts', "export { x } from 'mysql2';");
    expect(
      findViolations(root, AI_LAYER_RULES)
        .map((v) => v.file)
        .sort(),
    ).toEqual([
      'ask/b.ts',
      'join/d.ts',
      'llm/e.ts',
      'tools/a.ts',
      'tools/c.ts',
    ]);
  });

  it('透過 shop/index.ts 就可以；測試檔和 AI 層以外的資料夾不檢查', () => {
    write('tools/ok.ts', "import { ShopCatalog } from '../shop/index.js';");
    write('tools/ok.spec.ts', "import { createPool } from 'mysql2/promise';");
    write(
      'chat/chat.service.ts',
      "import type { Pool } from 'mysql2/promise';",
    );
    write(
      'shop/shop-catalog.service.ts',
      "import type { Pool } from 'mysql2/promise';",
    );
    expect(findViolations(root, AI_LAYER_RULES)).toEqual([]);
  });

  it('現在的程式沒有違規', () => {
    expect(findViolations(join(process.cwd(), 'src'), AI_LAYER_RULES)).toEqual(
      [],
    );
  });
});

describe('架構：退款的執行', () => {
  it('shop/index.ts 不匯出 ShopRefunds：AI 層連 import 都拿不到', async () => {
    const shop = await import('./shop/index.js');
    expect('ShopRefunds' in shop).toBe(false);
  });

  it('AI 層 import shop/shop-refunds 會被抓到', () => {
    write(
      'tools/x.ts',
      "import { ShopRefunds } from '../shop/shop-refunds.service.js';",
    );
    expect(findViolations(root, AI_LAYER_RULES).map((v) => v.file)).toEqual([
      'tools/x.ts',
    ]);
  });
});
