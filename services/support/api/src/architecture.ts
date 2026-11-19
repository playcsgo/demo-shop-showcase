import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface Rule {
  layers: string[]; // 受限制的資料夾（相對 src）
  forbid: (target: string) => boolean; // target：套件名稱，或相對 src 的路徑
  reason: string;
}

/**
 * AI 層（模型、工具、Ask、Join）只能透過 shop/index.ts 拿資料。
 * 碰不到 SQL，模型就算被騙，能做的也只有服務方法允許的事
 */
export const AI_LAYER_RULES: Rule[] = [
  {
    layers: ['llm', 'tools', 'ask', 'join'], // 路由判斷和摘要在 ask/
    forbid: (t) =>
      t === 'mysql2' ||
      t.startsWith('mysql2/') ||
      t.startsWith('db/') ||
      (t.startsWith('shop/') && t !== 'shop/index'),
    reason: 'AI 層只能透過 shop/index.ts 拿資料',
  },
];

const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) yield path;
  }
}

export function findViolations(
  srcRoot: string,
  rules: Rule[],
): { file: string; target: string; reason: string }[] {
  const found = [];
  for (const path of sourceFiles(srcRoot)) {
    const file = relative(srcRoot, path);
    const applicable = rules.filter((r) =>
      r.layers.some((l) => file.startsWith(`${l}/`)),
    );
    if (!applicable.length) continue;
    for (const m of readFileSync(path, 'utf8').matchAll(IMPORT)) {
      const spec = m[1] ?? m[2];
      const target = spec.startsWith('.')
        ? relative(srcRoot, resolve(dirname(path), spec)).replace(
            /\.(js|ts)$/,
            '',
          )
        : spec;
      for (const rule of applicable)
        if (rule.forbid(target))
          found.push({ file, target, reason: rule.reason });
    }
  }
  return found;
}
