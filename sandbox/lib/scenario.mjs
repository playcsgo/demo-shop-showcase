// 情境＝scenarios/ 底下的一個資料夾：
//   world.env    廠商長什麼樣子：PRESET（partners 的一鍵設定）＋個別覆寫（payment.errorRate=0.3）、SEED、TIME_SCALE
//   data.env     測試資料：CUSTOMERS、STOCK、STOCK.<SKU>、BUCKETS、BUCKETS.<SKU>（庫存分幾桶）
//   traffic.js   k6：誰、打什麼 API、打多少次
//   expect.env   跑完要符合什麼：INVARIANTS、SETTLE_WITHIN、MIN_PAID_RATIO、ORDERS_MIN／MAX／EXACT、MAX_ERROR_LOGS
//   KIND（world.env）：test（預設，CI 會跑）／load、soak（只在本機手動跑）
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ROOT } from './sets.mjs';

export const SCENARIOS_DIR = join(ROOT, 'scenarios');

/** KEY=VALUE；# 之後是註解；值不用引號 */
export function parseEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function loadScenario(nameOrPath) {
  const dir = existsSync(nameOrPath) ? nameOrPath : join(SCENARIOS_DIR, nameOrPath);
  if (!existsSync(join(dir, 'traffic.js'))) throw new Error(`找不到情境 ${nameOrPath}（需要 traffic.js）`);
  const world = parseEnv(join(dir, 'world.env'));
  const firstLine = readFileSync(join(dir, 'world.env'), 'utf8').split('\n')[0] ?? '';
  const head = firstLine.replace(/^#\s*/, '') || basename(dir);
  const cut = head.indexOf('：');
  const [title, description] = cut < 0 ? [head, ''] : [head.slice(0, cut), head.slice(cut + 1)];
  return {
    name: basename(dir),
    title,          // world.env 第一行註解「：」前面：完美世界
    description,    // 「：」後面：這個情境在測什麼
    dir,
    world,
    data: parseEnv(join(dir, 'data.env')),
    expect: parseEnv(join(dir, 'expect.env')),
    kind: world.KIND ?? 'test',
  };
}

/** 全部情境；kinds 決定要哪幾種（CI 只跑 test） */
export function allScenarios(kinds = ['test']) {
  return readdirSync(SCENARIOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SCENARIOS_DIR, d.name, 'traffic.js')))
    .map((d) => loadScenario(d.name))
    .filter((s) => kinds.includes(s.kind))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * world.env 裡廠商設定的部分：payment.errorRate=0.3 → { payment: { errorRate: '0.3' } }
 * prefix='RECOVER.'：恢復後的設定（RECOVER_AFTER 秒後套用，例如 RECOVER.payment.mode=normal）
 */
export function partnerOverrides(world, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(world)) {
    if (!k.startsWith(prefix)) continue;
    const m = k.slice(prefix.length).match(/^(payment|logistics|clinic|line)\.(\w+)$/);
    if (m) (out[m[1]] ??= {})[m[2]] = v;
  }
  return out;
}
