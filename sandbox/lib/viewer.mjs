// 在本機用 Grafana 查 CI（或別台電腦）跑出來的 log：
//   scripts/sandbox.sh logs 1234567890          GitHub Actions 的 run id → 用 gh 下載 artifact
//   scripts/sandbox.sh logs sandbox-runs/2026…  本機的資料夾
// 啟動 compose.viewer.yaml（Loki＋Grafana port 28000）→ 把 logs/*.jsonl 匯入 → 打開的就是平常那個 Debug log 儀表板
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ROOT, sh } from './sets.mjs';

const LOKI = 'http://localhost:28100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findJsonl(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findJsonl(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export async function openLogs(target, log) {
  let dir = target;
  if (/^\d+$/.test(target)) {
    dir = join(ROOT, 'sandbox-runs', `ci-${target}`);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log(`下載 GitHub Actions run ${target} 的 artifact`);
      const r = await sh('gh', ['run', 'download', target, '-n', 'sandbox-runs', '-D', dir]);
      if (r.code !== 0) throw new Error(`下載失敗（需要 gh auth login，且這次執行有上傳 artifact）：\n${r.out}`);
    }
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`找不到 ${dir}`);

  const files = findJsonl(dir);
  if (!files.length) throw new Error(`${dir} 裡沒有 log（只有失敗或 [ci-debug] 時才會匯出）`);

  log('啟動 Loki＋Grafana（compose.viewer.yaml）');
  const up = await sh('docker', ['compose', '-f', 'compose.viewer.yaml', 'up', '-d', '--quiet-pull']);
  if (up.code !== 0) throw new Error(up.out);
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${LOKI}/ready`).then((r) => r.ok).catch(() => false)) break;
    await sleep(1000);
  }

  // 同一行可能同時出現在好幾個檔案（不同訂單的時間線有重疊）→ 去重；依 service、level 分 stream，各自照時間排序
  const seen = new Set();
  const streams = new Map();
  let from = Infinity;
  let to = 0;
  const run = basename(dir);
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim() || seen.has(line)) continue;
      seen.add(line);
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const { _ts, _service, raw, ...rest } = parsed;
      const ms = Date.parse(_ts ?? rest.ts ?? '');   // 舊格式沒有 _ts：用 log 自己的 ts
      if (Number.isNaN(ms)) continue;
      from = Math.min(from, ms); to = Math.max(to, ms);
      const labels = { service: _service ?? rest.service ?? 'unknown', ...(rest.level ? { level: rest.level } : {}), run };
      const key = JSON.stringify(labels);
      if (!streams.has(key)) streams.set(key, { stream: labels, values: [] });
      streams.get(key).values.push([String(BigInt(ms) * 1000000n), raw ?? JSON.stringify(rest)]);
    }
  }
  for (const s of streams.values()) s.values.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
  const res = await fetch(`${LOKI}/loki/api/v1/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ streams: [...streams.values()] }) });
  if (!res.ok) throw new Error(`匯入 Loki 失敗：${res.status} ${await res.text()}`);

  const url = `http://localhost:28000/d/demo-debug?from=${from - 60_000}&to=${to + 60_000}`;
  log(`匯入 ${seen.size} 行（${files.length} 個檔案）。用標籤 run="${run}" 區分不同次的匯入`);
  log(`打開：${url}`);
  log('看完要清掉：docker compose -f compose.viewer.yaml down -v');
  return url;
}
