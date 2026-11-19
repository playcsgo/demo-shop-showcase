// 報告：回答「哪邊 fail、為什麼 fail、在什麼情況下 fail、怎麼重現」
// 只收集跟失敗有關的：違反不變式的訂單、沒收斂的訂單、非預期的 API 回應 → 各自的完整時間線、被注入了什麼、資料庫最後狀態
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadReport } from './load.mjs';

const MAX_TARGETS = 5;

/** k6 的 correlation_id 是 s42-u17-i3-checkout：同一輪的所有請求（加入購物車、結帳、背景流程）都用 s42-u17-i3- 開頭 */
export const flowOf = (corr) => corr?.match(/^(s[^-]+-u\d+-i\d+)-/)?.[1] ?? null;

export async function collectEvidence(set, result, report, { startNs, outDir, exportAllLogs }) {
  const logsDir = join(outDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  // 查詢失敗照樣收集其他證據，但報告要寫出來（不然空的 log 檔看起來像「沒有 log」）
  const loki = (query, opts) => set.loki(query, opts).catch((err) => { result.logWarning = err.message; return []; });
  const targets = [];   // { reason, order_no?, correlation_id, row? }
  const seen = new Set();
  const push = (t) => {
    const key = t.order_no ?? t.correlation_id;
    if (!key || seen.has(key) || targets.length >= MAX_TARGETS) return;
    seen.add(key);
    targets.push(t);
  };

  // 哪幾筆：不變式違反 → 沒收斂 → 非預期的 API 回應
  for (const [name, c] of Object.entries(report.checks)) {
    if (c.ok) continue;
    for (const orderNo of c.order_nos) push({ reason: `不變式：${name}`, order_no: orderNo, correlation_id: report.correlation_ids?.[orderNo], row: c.rows.find((r) => r.order_no === orderNo) });
    if (!c.order_nos.length) result.nonOrderViolations = [...(result.nonOrderViolations ?? []), { name, rows: c.rows.slice(0, 5) }];
  }
  if (Object.values(report.in_flight).some((v) => v > 0)) {
    const rows = await set.sql(`SELECT o.order_no, o.correlation_id, o.status FROM orders o
      WHERE o.status = 'PENDING_PAYMENT'
         OR o.id IN (SELECT order_id FROM shipments WHERE status NOT IN ('DELIVERED','FAILED'))
         OR o.order_no IN (SELECT order_no FROM bookings WHERE status IN ('HELD','AUTHORIZED'))
         OR o.id IN (SELECT order_id FROM payments WHERE status = 'AUTHORIZED')
      LIMIT ${MAX_TARGETS}`);
    for (const [orderNo, corr, status] of rows) push({ reason: `沒有收斂（訂單停在 ${status}）`, order_no: orderNo, correlation_id: corr });
  }
  for (const u of result.unexpected ?? []) push({ reason: `非預期的 API 回應：${u.action} → ${u.status}`, correlation_id: u.correlation_id, response: u.body });

  // 每一筆：完整時間線、被注入的故障、資料庫最後狀態
  const orderNos = targets.map((t) => t.order_no).filter(Boolean);
  let snapshot = {};
  if (orderNos.length) {
    const r = await set.artisan('sandbox:snapshot', ...orderNos);
    const start = r.out.indexOf('{');
    try { snapshot = JSON.parse(r.out.slice(start)); } catch { snapshot = {}; }
    writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  }
  for (const t of targets) {
    t.flow = flowOf(t.correlation_id);
    const needle = t.flow ? `${t.flow}-` : t.correlation_id;
    const lines = needle ? await loki(`{service=~".+"} |= "${needle}"`, { startNs }) : [];
    const file = `${(t.order_no ?? t.correlation_id ?? 'unknown').replace(/[^\w.-]/g, '_')}.jsonl`;
    writeFileSync(join(logsDir, file), lines.map(toJsonl).join('\n'));
    t.logFile = `logs/${file}`;
    t.logCount = lines.length;
    const parsed = lines.map((l) => { try { return { ...JSON.parse(l.line), _service: l.service, _ts: l.ts }; } catch { return { msg: l.line, _service: l.service, _ts: l.ts }; } });
    t.faults = parsed.filter((p) => p.kind === 'fault.injected').map((p) => `${p.op} → ${p.decision}${p.rate ? `（機率 ${p.rate}，擲出 ${p.roll}）` : ''}`);
    t.timeline = parsed.filter((p) => ['warn', 'error'].includes(p.level) || /→|skipped|duplicate|order placed|confirmed|authorized|succeeded|failed|captured|voided/.test(p.msg ?? ''))
      .slice(0, 40).map((p) => `${new Date(p._ts).toISOString().slice(11, 23)} ${String(p._service).padEnd(16)} ${String(p.level ?? '').padEnd(5)} ${p.msg}`);
    t.snapshot = t.order_no ? summarizeSnapshot(snapshot[t.order_no]) : null;
    t.concurrent = t.order_no ? (snapshot[t.order_no]?.concurrent_orders ?? []) : [];
  }
  result.evidence = { targets, orders: orderNos };

  if (exportAllLogs) {
    const all = await loki('{service=~".+"}', { startNs, limit: 5000 });
    if (!all.length) result.logWarning ??= 'Loki 沒有任何 log：Alloy 可能沒收到容器的輸出（CI 的「診斷」步驟會印出 Alloy、Loki 的狀態）';
    writeFileSync(join(logsDir, 'all.jsonl'), all.map(toJsonl).join('\n'));
    result.evidence.allLogs = { file: 'logs/all.jsonl', count: all.length, truncated: all.length >= 5000 };
  }
}

/** 匯出的每一行：原本的 log（JSON 的話攤開）＋ _ts、_service（nginx 這種不是 JSON 的放在 raw）；scripts/sandbox.sh logs 匯入時用 */
function toJsonl(l) {
  const meta = { _ts: new Date(l.ts).toISOString(), _service: l.service };
  try { return JSON.stringify({ ...meta, ...JSON.parse(l.line) }); } catch { return JSON.stringify({ ...meta, raw: l.line }); }
}

function summarizeSnapshot(s) {
  if (!s) return null;
  const lines = [`orders    ${s.order.order_no}  ${s.order.status}  總額 ${s.order.total ?? s.order.grand_total ?? ''}`];
  for (const p of s.payments) lines.push(`payments  #${p.id}  ${p.status}  ${p.amount}${p.refunded_amount ? `（已退 ${p.refunded_amount}）` : ''}  ${p.provider_txn_id ?? ''}`);
  for (const r of s.refunds) lines.push(`refunds   #${r.id}  ${r.status}  ${r.amount}`);
  for (const b of s.bookings) lines.push(`bookings  #${b.id}  ${b.status}  hold ${b.hold_id}${b.failure_reason ? `  原因 ${b.failure_reason}` : ''}`);
  for (const sh of s.shipments) lines.push(`shipments #${sh.id}  ${sh.status}  ${sh.carrier} ${sh.tracking_no ?? ''}`);
  for (const o of s.outbox) lines.push(`outbox    ${o.type}  ${o.status}（嘗試 ${o.attempts} 次）`);
  return lines;
}

const fmt = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s` : `${sec.toFixed(1)}s`);
const STATUS = { passed: '✅ 通過', failed: '❌ 失敗', invalid: '⚠️ 設定不合理（沒有執行）', error: '💥 執行錯誤', running: '…' };

export function writeReport(r, outDir) {
  const md = [];
  md.push(`# ${STATUS[r.status]}：${r.title}（${r.scenario}）`, '', `> ${r.description}`, '');
  md.push(`版本 ${r.version ?? '?'} ｜ seed=${r.seed} ｜ 時間壓縮 ×${r.timeScale} ｜ 第 ${r.setNo} 套（${r.set}）｜ 總時間 ${fmt(r.timings.total ?? 0)}${r.only ? ` ｜ 只跑 ${r.only}` : ''}`, '');
  if (r.orders) md.push(`訂單 ${r.orders.total} 筆，已付款 ${r.orders.paid} 筆`, '');

  md.push(...loadReport(r));
  md.push('## 判定', '');
  for (const c of r.checks) md.push(`- ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `：${c.detail}` : ''}`);
  if (r.error) md.push('', '```', r.error.slice(0, 3000), '```');
  md.push('');

  for (const v of r.nonOrderViolations ?? []) md.push(`### ${v.name}（不是以訂單為單位）`, '```json', JSON.stringify(v.rows, null, 2), '```', '');

  for (const t of r.evidence?.targets ?? []) {
    md.push(`## ${t.order_no ?? t.correlation_id}${t.flow ? `（flow ${t.flow}）` : ''}`, '');
    md.push('**哪邊 fail**：' + t.reason, '');
    if (t.row) md.push('**為什麼 fail**（違反的資料：實際值）', '```json', JSON.stringify(t.row), '```');
    if (t.response) md.push('**API 回應**', '```', t.response, '```');
    if (t.snapshot) md.push('**最後狀態（資料庫）**', '```', ...t.snapshot, '```');
    if (t.timeline?.length) md.push(`**時間線**（warn、error 和狀態變化；完整 ${t.logCount} 行在 \`${t.logFile}\`）`, '```', ...t.timeline, '```');
    md.push('**在什麼情況下 fail**', '');
    md.push(t.faults?.length ? t.faults.map((f) => `- 被注入：${f}`).join('\n') : '- 這筆沒有被注入任何故障');
    if (t.concurrent?.length) md.push(`- 前後 10 秒內還有 ${t.concurrent.length} 筆訂單買了同樣的商品：${t.concurrent.slice(0, 10).join('、')}`);
    if (t.flow) md.push('', '**重現**', '```bash', `scripts/sandbox.sh run ${r.scenario} --seed ${r.seed} --only ${t.flow}`, '```');
    md.push('');
  }
  if (r.logWarning) md.push(`⚠️ ${r.logWarning}`, '');
  if (r.evidence?.allLogs) md.push(`全部 log：\`${r.evidence.allLogs.file}\`（${r.evidence.allLogs.count} 行${r.evidence.allLogs.truncated ? '，已截斷' : ''}）`, '');

  if (r.timeCheck) {
    md.push('## 時間', '', `壓縮 ×${r.timeScale}｜最短的逾時 ${r.timeCheck.shortest_timeout_ms} ms｜真實處理時間 p99 ${r.timeCheck.real_p99_ms} ms${r.baseline ? `（${r.baseline.measured_at.slice(0, 16)} 量的）` : '（還沒量過，用預設 100 ms；先跑一次 perfect）'}`, '');
    const bad = r.timeCheck.rules.filter((x) => !x.ok);
    if (bad.length) md.push(...bad.map((x) => `- ❌ ${x.rule}：${x.left} ${x.op} ${x.right} 不成立`), '');
  }
  if (r.baselineMeasured) md.push(`這次更新了真實處理時間的基準：p99 ${r.baselineMeasured.real_p99_ms} ms（${r.baselineMeasured.samples} 筆）`, '');
  if (r.datadog && r.startedAt) {
    const from = Date.parse(r.startedAt) - 60_000;
    const to = from + (r.timings.total + 120) * 1000;
    const q = encodeURIComponent(`env:${r.datadog.env}`);
    md.push('## Datadog', '', `送出的服務：${r.datadog.services.join('、')}（env:${r.datadog.env}）`, '',
      `- [trace](https://${r.datadog.site}/apm/traces?query=${q}&start=${from}&end=${to})　[log](https://${r.datadog.site}/logs?query=${q}&from_ts=${from}&to_ts=${to})　[Service Map](https://${r.datadog.site}/apm/map?env=${encodeURIComponent(r.datadog.env)}&start=${from}&end=${to})`, '');
  }
  md.push('## 世界設定', '', '```', ...Object.entries(r.world ?? {}).map(([k, v]) => `${k}=${v}`), '```', '');
  md.push('## 各階段耗時', '', '| 階段 | 秒 |', '|---|---|', ...Object.entries(r.timings).map(([k, v]) => `| ${{ restart: '重建 core', reset: '重置', world: '設定世界', traffic: '流量（k6）', settle: '等收斂', check: '判定', evidence: '收集證據', total: '總計' }[k] ?? k} | ${v.toFixed(1)} |`), '');

  writeFileSync(join(outDir, 'report.md'), md.join('\n'));
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(r, null, 2));
}
