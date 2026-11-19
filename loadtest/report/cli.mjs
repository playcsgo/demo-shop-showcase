#!/usr/bin/env node
// 產生壓測報告
//   node loadtest/report/cli.mjs <run.json> [--baseline <run.json>]   → 寫在 run.json 旁邊的 report.md、report.html（有圖表）
//   node loadtest/report/cli.mjs --sample                             → 用假資料產生範例報告（loadtest/report/sample-report.*）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHtml } from './html.mjs';
import { render } from './render.mjs';
import { sampleRun } from './sample.mjs';

const args = process.argv.slice(2);
const load = (f) => JSON.parse(readFileSync(f, 'utf8'));

if (args[0] === '--sample') {
  const dir = dirname(fileURLToPath(import.meta.url));
  const [run, base] = [sampleRun({ buckets: 8 }), sampleRun({ buckets: 1 })];
  writeFileSync(join(dir, 'sample-report.md'), render(run, base));
  writeFileSync(join(dir, 'sample-report.html'), renderHtml(run, base));
  console.log(join(dir, 'sample-report.html'));
} else if (args[0]) {
  const b = args.indexOf('--baseline');
  const [run, base] = [load(args[0]), b > -1 ? load(args[b + 1]) : null];
  writeFileSync(join(dirname(args[0]), 'report.md'), render(run, base));
  writeFileSync(join(dirname(args[0]), 'report.html'), renderHtml(run, base));
  console.log(join(dirname(args[0]), 'report.html'));
} else {
  console.error('用法：node loadtest/report/cli.mjs <run.json> [--baseline <run.json>]　或　--sample');
  process.exit(1);
}
