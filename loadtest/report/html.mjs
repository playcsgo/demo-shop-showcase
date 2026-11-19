// HTML 版壓測報告：Markdown 報告的內容＋圖表（單一檔案、不連外網，直接用瀏覽器開）
// 圖表插在對應的章節開頭；表格保留，數字永遠查得到（圖只是幫忙看）
import { apiPool } from '../naming.mjs';
import { predictWorld } from './predict.mjs';
import { levelName, modeOf, queueName, render, saturation, SATURATED, slowReasons, STEP_NAME, summarize, WORLDS } from './render.mjs';

const WORLD_NAME = { perfect: '完美世界', realistic: '真實世界' };
const METRIC_NAME = { query: '查詢', pay_api: '結帳 API', pay_e2e: '結帳到付款完成' };
// 類別色固定順序（色盲驗證過）；世界固定用前兩個，服務依名字固定配色，不會因為篩選換色
const SLOTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)'];
const WORLD_COLOR = { perfect: SLOTS[0], realistic: SLOTS[1] };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMs = (v) => (v == null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} 秒` : `${Math.round(v)} ms`);
const tip = (title, rows) => `data-tip="${esc(JSON.stringify({ title, rows }))}" tabindex="0"`;

/** 漂亮的刻度：0 到 max，4～6 格 */
function ticks(max) {
  if (!(max > 0)) return [0, 1];
  const raw = max / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => raw <= x);
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out.at(-1) < max) out.push(out.at(-1) + step);
  return out;
}

/**
 * 折線圖（x 是類別：每一階或時間點）
 * series: [{ name, color, values, faint }]，faint＝次要的線（細、淡）
 * opts: { yFmt, xLabels, title, note, refLine: { y, label }, bands: [{ from, to, label }]（時間軸的階段底色）, xFmt, step }
 */
function lineChart(series, opts) {
  const W = 360, H = 220, L = 48, R = 12, T = opts.bands ? 26 : 12, B = 34;
  const n = opts.xLabels.length;
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  const yt = ticks(Math.max(...all, opts.refLine?.y ?? 0) * 1.05);
  const yMax = yt.at(-1);
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (H - T - B) * (1 - v / yMax);
  const yFmt = opts.yFmt ?? String;
  const parts = [];
  for (const b of opts.bands ?? []) {
    const x0 = x(b.from), x1 = x(Math.min(b.to, n - 1));
    if (b.shade) parts.push(`<rect x="${x0}" y="${T}" width="${Math.max(0, x1 - x0)}" height="${H - T - B}" class="band"/>`);
    parts.push(`<text x="${(x0 + x1) / 2}" y="${T - 8}" class="axis" text-anchor="middle">${esc(b.label)}</text>`);
  }
  for (const v of yt) parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'base' : 'grid'}"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${esc(yFmt(v))}</text>`);
  const every = Math.ceil(n / 6);
  opts.xLabels.forEach((lab, i) => {
    if ((i % every === 0 && n - 1 - i >= every) || i === n - 1) parts.push(`<text x="${x(i)}" y="${H - B + 16}" class="axis" text-anchor="middle">${esc(opts.xFmt ? opts.xFmt(lab) : lab)}</text>`);
  });
  if (opts.refLine) parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(opts.refLine.y)}" y2="${y(opts.refLine.y)}" class="ref"/><text x="${W - R}" y="${y(opts.refLine.y) - 4}" class="axis" text-anchor="end">${esc(opts.refLine.label)}</text>`);
  for (const s of series) {
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)]));
    let d = '', pen = false, last = null;
    pts.forEach((p) => {
      if (!p) { pen = false; return; }
      if (opts.step && last) d += ` L${p[0]},${last[1]}`;
      d += `${pen ? ' L' : ' M'}${p[0]},${p[1]}`;
      pen = true; last = p;
    });
    parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.faint ? 1.5 : 2}" stroke-opacity="${s.faint ? 0.45 : 1}" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (!opts.step && n <= 12) for (const p of pts) if (p) parts.push(`<circle cx="${p[0]}" cy="${p[1]}" r="${s.faint ? 3 : 4}" fill="${s.color}" fill-opacity="${s.faint ? 0.45 : 1}" class="dot"/>`);
  }
  for (const mk of opts.markers ?? []) parts.push(`<text x="${x(mk.i)}" y="${y(mk.v) - 10}" class="mark" text-anchor="middle">${esc(mk.label)}</text>`);
  // 十字線：每個 x 一條看不見的直條，滑過去列出這個位置所有線的值
  const colW = n === 1 ? W - L - R : (W - L - R) / (n - 1);
  opts.xLabels.forEach((lab, i) => {
    const rows = series.map((s) => [s.color, s.values[i] == null ? '-' : yFmt(s.values[i]), s.name]);
    parts.push(`<rect x="${x(i) - colW / 2}" y="${T}" width="${colW}" height="${H - T - B}" class="hit" ${tip(opts.xFmt ? opts.xFmt(lab) : lab, rows)}/>`);
  });
  return figure(opts.title, `<svg viewBox="0 0 ${W} ${H}" style="max-width:${W * 1.6}px" role="img" aria-label="${esc(opts.title)}">${parts.join('')}<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}"/></svg>`, series.length > 1 ? legend(series) : '', opts.note);
}

const figure = (title, svg, leg = '', note = '') => `<figure class="chart"><figcaption>${esc(title)}</figcaption>${leg}${svg}${note ? `<p class="note">${esc(note)}</p>` : ''}</figure>`;
const legend = (series) => `<div class="legend">${series.map((s) => `<span><i style="background:${s.color};opacity:${s.faint ? 0.45 : 1}"></i>${esc(s.name)}</span>`).join('')}</div>`;

// ───────── 3. 推測 vs 實測：偏差（實測 ÷ 推測），對數軸，1× 在中間 ─────────
function deviationChart(run) {
  const rows = [];
  for (const w of WORLDS.filter((x) => run.worlds[x])) {
    const pred = predictWorld(run.worlds[w].partnerSettings);
    for (const k of ['query', 'pay_api', 'pay_e2e']) {
      const real = run.worlds[w].idle?.[k];
      if (!real) continue;
      const r = (p) => (real[p] && pred[k][p] ? real[p] / pred[k][p] : null);
      rows.push({ w, k, label: `${WORLD_NAME[w]}　${METRIC_NAME[k]}`, r50: r('p50'), r95: r('p95'), r99: r('p99'), pred: pred[k], real });
    }
  }
  const W = 560, rowH = 30, L = 170, R = 16, T = 26, H = T + rows.length * rowH + 24;
  const lo = Math.log(0.25), hi = Math.log(4);
  const x = (v) => L + ((Math.log(Math.min(4, Math.max(0.25, v))) - lo) / (hi - lo)) * (W - L - R);
  const p = [`<rect x="${x(0.5)}" y="${T - 6}" width="${x(1.5) - x(0.5)}" height="${rows.length * rowH + 6}" class="band"/>`,
    `<text x="${(x(0.5) + x(1.5)) / 2}" y="${T - 10}" class="axis" text-anchor="middle">合理範圍 0.5～1.5×</text>`];
  for (const t of [0.25, 0.5, 1, 2, 4]) p.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${T - 6}" y2="${T + rows.length * rowH}" class="${t === 1 ? 'base' : 'grid'}"/><text x="${x(t)}" y="${T + rows.length * rowH + 16}" class="axis" text-anchor="middle">${t}×</text>`);
  rows.forEach((r, i) => {
    const cy = T + i * rowH + rowH / 2;
    const vals = [r.r50, r.r95, r.r99].filter((v) => v != null);
    const off = vals.some((v) => v > 1.5 || v < 0.5);
    p.push(`<text x="${L - 10}" y="${cy + 4}" class="label" text-anchor="end">${off ? '⚠️ ' : ''}${esc(r.label)}</text>`);
    p.push(`<line x1="${x(Math.min(...vals))}" x2="${x(Math.max(...vals))}" y1="${cy}" y2="${cy}" stroke="${WORLD_COLOR[r.w]}" stroke-width="2" stroke-linecap="round"/>`);
    if (r.r95) p.push(`<circle cx="${x(r.r95)}" cy="${cy}" r="5" fill="${WORLD_COLOR[r.w]}" class="dot"/>`);
    p.push(`<rect x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}" class="hit" ${tip(r.label, [
      [null, `${fmtMs(r.pred.p50)} ／ ${fmtMs(r.pred.p95)} ／ ${fmtMs(r.pred.p99)}`, '推測 p50／p95／p99'],
      [null, `${fmtMs(r.real.p50)} ／ ${fmtMs(r.real.p95)} ／ ${fmtMs(r.real.p99)}`, '實測 p50／p95／p99'],
      [WORLD_COLOR[r.w], `${r.r95?.toFixed(2) ?? '-'}×`, 'p95 偏差'],
    ])}/>`);
  });
  return figure('推測 vs 實測：實測 ÷ 推測（圓點＝p95，線段＝p50 到 p99 的範圍）', `<svg viewBox="0 0 ${W} ${H}" style="max-width:${W * 1.25}px" role="img" aria-label="推測與實測的偏差">${p.join('')}</svg>`,
    legend(WORLDS.filter((w) => run.worlds[w]).map((w) => ({ name: WORLD_NAME[w], color: WORLD_COLOR[w] }))), '落在灰色範圍外的要查：推測錯了，或系統有沒料到的行為');
}

// ───────── 4. 各階負載：延遲、吞吐量 ─────────
function latencyCharts(run) {
  const worlds = WORLDS.filter((w) => run.worlds[w]);
  const lvs = run.worlds[worlds[0]].levels ?? [];
  const xLabels = lvs.map(levelName);
  const charts = ['query', 'pay_api', 'pay_e2e'].map((k) => {
    const series = worlds.flatMap((w) => [
      { name: `${WORLD_NAME[w]} p95`, color: WORLD_COLOR[w], values: run.worlds[w].levels.map((lv) => lv[k]?.p95 ?? null) },
      { name: `${WORLD_NAME[w]} p99`, color: WORLD_COLOR[w], faint: true, values: run.worlds[w].levels.map((lv) => lv[k]?.p99 ?? null) },
    ]);
    const markers = worlds.map((w) => {
      const i = run.worlds[w].levels.findIndex((lv) => slowReasons(lv, run.worlds[w].idle).length);
      return i === -1 ? null : { i, v: run.worlds[w].levels[i][k]?.p99 ?? 0, label: '🔴' };
    }).filter(Boolean).slice(0, 1);
    return lineChart(series, { title: `${METRIC_NAME[k]}（p95 實線、p99 淡線）`, xLabels, yFmt: fmtMs, xFmt: (s) => s.replace(/＋查詢.*/, '').replace('下單 ', ''), markers });
  });
  const thr = worlds.map((w) => ({ name: `${WORLD_NAME[w]} 實際送出`, color: WORLD_COLOR[w], values: run.worlds[w].levels.map((lv) => lv.achieved?.order ?? null) }));
  thr.unshift({ name: '目標', color: 'var(--muted)', faint: true, values: lvs.map((lv) => lv.target.order) });
  const dropped = worlds.map((w) => ({ name: `${WORLD_NAME[w]} 進不來`, color: WORLD_COLOR[w], values: run.worlds[w].levels.map((lv) => lv.dropped ?? 0) }));
  // 每一種請求的 p95：看是哪一種先變慢（每個世界一張；步驟固定配色）
  const stepCharts = worlds.map((w) => {
    const W = run.worlds[w];
    const cols = [W.idle, ...(W.levels ?? [])];
    const steps = Object.keys(STEP_NAME).filter((st) => cols.some((x) => x?.steps?.[st]));
    if (!steps.length) return '';
    return lineChart(steps.map((st) => ({ name: STEP_NAME[st], color: SLOTS[Object.keys(STEP_NAME).indexOf(st)], values: cols.map((x) => x?.steps?.[st]?.p95 ?? null) })),
      { title: `${WORLD_NAME[w]}：每一種請求的 p95`, xLabels: ['低流量', ...(W.levels ?? []).map((lv) => `${lv.target.order}`)], yFmt: fmtMs });
  }).join('');
  return `<p class="note">橫軸是每一階的每秒下單數（查詢同時打，是下單的 ${run.meta.queryRatio ?? '-'} 倍）。🔴＝從這一階開始變慢</p><div class="grid">${charts.join('')}${stepCharts}${
    lineChart(thr, { title: '每秒下單：目標 vs 實際送出', xLabels, yFmt: (v) => `${Math.round(v)}`, xFmt: (s) => s.replace(/＋查詢.*/, '').replace('下單 ', '') })}${
    lineChart(dropped, { title: '進不來的客人（k6 開不出虛擬客人）', xLabels, yFmt: (v) => `${Math.round(v)}`, xFmt: (s) => s.replace(/＋查詢.*/, '').replace('下單 ', '') })}</div>`;
}

// ───────── 5. 瓶頸：飽和熱圖、Pod 數與 CPU ─────────
/** 每個指標在每一階「佔門檻的比例」：1＝剛好到飽和線 */
function loadRows(world, mode, runtime) {
  const lvs = world.levels ?? [];
  const rows = new Map();
  const put = (key, label, i, ratio, text) => {
    if (!rows.has(key)) rows.set(key, { label, cells: Array(lvs.length).fill(null) });
    rows.get(key).cells[i] = { ratio, text };
  };
  lvs.forEach((lv, i) => {
    const s = lv.sat ?? {};
    for (const [n, x] of Object.entries(s.services ?? {})) {
      if (x.cpuCapM) put(`cpu:${n}`, `${n} CPU`, i, x.cpuM / x.cpuCapM / SATURATED.cpu, `${Math.round((x.cpuM / x.cpuCapM) * 100)}%`);
      if (modeOf(mode) === 'k8s-auto' && x.maxPods > 1) put(`pods:${n}`, `${n} Pod 數`, i, x.pods / x.maxPods, `${x.pods}/${x.maxPods}`);
    }
    if (s.fpm?.max) put('fpm', apiPool(runtime).heat, i, s.fpm.busy / s.fpm.max / SATURATED.fpm, `${s.fpm.busy}/${s.fpm.max}`);
    if (s.db?.maxConns) put('dbconn', 'MySQL 連線', i, s.db.conns / s.db.maxConns / SATURATED.dbConns, `${s.db.conns}`);
    if (s.db?.lockWaits != null) put('lock', 'MySQL 等鎖', i, s.db.lockWaits / SATURATED.lockWaits, `${s.db.lockWaits}`);
    for (const [q, x] of Object.entries(s.sqs ?? {})) put(`sqs:${q}`, queueName(q), i, x.growthPerSec / SATURATED.sqsGrowthPerSec, `${x.growthPerSec > 0 ? '+' : ''}${x.growthPerSec}/s`);
    if (s.host?.cpus) put('host', '整台電腦 CPU', i, s.host.cpuUsed / s.host.cpus / SATURATED.hostCpu, `${s.host.cpuUsed}/${s.host.cpus}`);
  });
  // 飽和的排前面（照最早飽和），其餘照最高負載
  const firstSat = (r) => { const i = r.cells.findIndex((c) => c && c.ratio >= 1); return i === -1 ? 99 : i; };
  return [...rows.values()].sort((a, b) => firstSat(a) - firstSat(b) || Math.max(...b.cells.map((c) => c?.ratio ?? 0)) - Math.max(...a.cells.map((c) => c?.ratio ?? 0)));
}

function heatmap(world, mode, runtime, title) {
  const lvs = world.levels ?? [];
  // 只列飽和的、或至少一階到門檻 25% 的；其他收成一行
  const all = loadRows(world, mode, runtime);
  const rows = all.filter((r) => r.cells.some((c) => c && c.ratio >= 0.25));
  const hidden = all.length - rows.length;
  const W = 640, L = 190, T = 30, cellH = 24, gap = 2, cw = (W - L) / lvs.length;
  const H = T + rows.length * cellH + 8;
  // 未飽和：藍色深淺（負載多高）；飽和：紅色＋「!」
  // 負數＝積壓在減少，跟 0 一樣算最淡
  const fill = (r) => (r >= 1 ? 'var(--crit)' : ['var(--q1)', 'var(--q2)', 'var(--q3)', 'var(--q4)'][Math.min(3, Math.max(0, Math.floor(r * 4)))]);
  const p = lvs.map((lv, i) => `<text x="${L + i * cw + cw / 2}" y="${T - 10}" class="axis" text-anchor="middle">${esc(levelName(lv).replace(/＋查詢.*/, '').replace('下單 ', ''))}／秒</text>`);
  rows.forEach((r, ri) => {
    const y0 = T + ri * cellH;
    p.push(`<text x="${L - 8}" y="${y0 + cellH / 2 + 4}" class="label" text-anchor="end">${esc(r.label)}</text>`);
    r.cells.forEach((c, i) => {
      if (!c) return;
      const sat = c.ratio >= 1;
      p.push(`<rect x="${L + i * cw + gap / 2}" y="${y0 + gap / 2}" width="${cw - gap}" height="${cellH - gap}" rx="3" fill="${fill(c.ratio)}" class="cell" ${tip(`${r.label}　${levelName(lvs[i])}`, [[null, c.text, sat ? '已飽和' : `門檻的 ${Math.round(c.ratio * 100)}%`]])}/>`);
      p.push(`<text x="${L + i * cw + cw / 2}" y="${y0 + cellH / 2 + 4}" class="${sat || c.ratio >= 0.75 ? 'cell-text-on' : 'cell-text'}" text-anchor="middle">${sat ? '! ' : ''}${esc(c.text)}</text>`);
    });
  });
  const leg = `<div class="legend"><span><i style="background:var(--q1)"></i>門檻的 0～25%</span><span><i style="background:var(--q2)"></i>25～50%</span><span><i style="background:var(--q3)"></i>50～75%</span><span><i style="background:var(--q4)"></i>75～100%</span><span><i style="background:var(--crit)"></i>! 飽和</span></div>`;
  const note = `照最早飽和排序：最上面的先看。同一階一起飽和的，要人判斷誰造成誰${hidden ? `。另外 ${hidden} 項每一階都低於門檻 25%，沒列出來（數字在下面的表格）` : ''}`;
  return figure(title, rows.length ? `<svg viewBox="0 0 ${W} ${H}" style="max-width:${W * 1.25}px" role="img" aria-label="${esc(title)}">${p.join('')}</svg>` : '<p class="note">每一項都低於門檻 25%</p>', leg, note);
}

function podCharts(world, meta) {
  const ts = world.timeseries ?? [];
  if (!ts.length) return '<p class="note">⚠️ 沒有時間序列資料（timeseries），畫不出 Pod 數與 CPU 的變化</p>';
  const names = Object.keys(ts[0].services);
  const xLabels = ts.map((s) => s.t);
  const step = meta.rampSec + meta.holdSec;
  const idx = (t) => ts.findIndex((s) => s.t >= t);
  const bands = (world.levels ?? []).map((lv, i) => ({ from: Math.max(0, idx(i * step + meta.rampSec)), to: idx((i + 1) * step) === -1 ? ts.length - 1 : idx((i + 1) * step), label: `${lv.target.order}／秒`, shade: true }));
  // Pod 數：只畫有變過的（其他都是水平線）；CPU：最高的幾個。兩張圖共用一組配色，類別色只有 7 個，超過就分不出來
  const podsChanged = names.filter((n) => new Set(ts.map((s) => s.services[n]?.pods)).size > 1);
  const byCpu = names.map((n) => [n, Math.max(...ts.map((s) => s.services[n]?.cpuM ?? 0))]).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const scaled = podsChanged.slice(0, SLOTS.length);
  const busiest = [...scaled, ...byCpu.filter((n) => !scaled.includes(n))].slice(0, SLOTS.length);
  const color = Object.fromEntries([...new Set([...scaled, ...busiest])].sort().map((n, i) => [n, SLOTS[i]]));
  const out = [];
  if (meta.mode !== 'dev-container' && meta.mode !== 'sandbox') {   // sandbox 是舊的 run.json
    out.push(scaled.length
      ? lineChart(scaled.map((n) => ({ name: n, color: color[n], values: ts.map((s) => s.services[n]?.pods ?? null) })),
        { title: `Pod 數${scaled.length === 1 ? `：${scaled[0]}` : ''}（只畫有擴充的服務；底色＝每一階維持的那段）`, xLabels, step: true, yFmt: (v) => `${Math.round(v)}`, xFmt: (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, bands })
      : '<p class="note">這一輪沒有任何服務的 Pod 數有變化</p>');
  }
  out.push(lineChart(busiest.map((n) => ({ name: n, color: color[n], values: ts.map((s) => (s.services[n] ? s.services[n].cpuM / 1000 : null)) })),
    { title: '每個 Pod 的平均 CPU（核；有擴充的＋CPU 最高的，共 7 個服務）', xLabels, yFmt: (v) => `${Math.round(v * 10) / 10}`, xFmt: (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, refLine: { y: 1, label: '單執行緒上限 1 核' }, bands,
      note: `${apiPool(meta.runtime).process}、MySQL 是多程序（Go 是多執行緒），可以超過 1 核` }));
  return `<div class="grid">${out.join('')}</div>`;
}

function bottleneckCharts(run) {
  return WORLDS.filter((w) => run.worlds[w]).map((w) => {
    const s = summarize(run.worlds[w], run.meta.mode, run.meta.runtime);
    return `<h3>${WORLD_NAME[w]}</h3>${heatmap(run.worlds[w], run.meta.mode, run.meta.runtime, `${WORLD_NAME[w]}：各指標佔飽和門檻的比例`)}${podCharts(run.worlds[w], run.meta)}${
      s.hints.length ? `<ul class="hints">${s.hints.map((h) => `<li>💡 ${esc(h)}</li>`).join('')}</ul>` : ''}`;
  }).join('');
}

// ───────── 6. 跟基準比：p99 疊圖 ─────────
function compareCharts(run, baseline) {
  const worlds = WORLDS.filter((w) => run.worlds[w] && baseline.worlds[w]);
  const out = [];
  for (const w of worlds) {
    const lvs = run.worlds[w].levels ?? [];
    const xLabels = ['低流量', ...lvs.map((lv) => `${lv.target.order}`)];
    for (const k of ['pay_api', 'pay_e2e']) {
      const pick = (world) => [world.idle?.[k]?.p99 ?? null, ...lvs.map((lv) => world.levels?.find((b) => b.target.order === lv.target.order && b.target.query === lv.target.query)?.[k]?.p99 ?? null)];
      out.push(lineChart([
        { name: `基準（${baseline.meta.change ?? baseline.meta.id}）`, color: 'var(--muted)', values: pick(baseline.worlds[w]) },
        { name: `這一輪（${run.meta.change ?? run.meta.id}）`, color: WORLD_COLOR[w], values: pick(run.worlds[w]) },
      ], { title: `${WORLD_NAME[w]}：${METRIC_NAME[k]} p99`, xLabels, yFmt: fmtMs }));
    }
  }
  return `<p class="note">橫軸是每一階的每秒下單數</p><div class="grid">${out.join('')}</div>`;
}

// ───────── Markdown → HTML（只處理報告用到的語法） ─────────
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function mdToHtml(md, insertAfter) {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.slice(1, -1).split(' | ').map((c) => c.trim().replace(/^\| ?| ?\|$/g, ''));
      out.push(`<div class="table"><table><thead><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (l.startsWith('# ')) out.push(`<h1>${inline(l.slice(2))}</h1>`);
    else if (l.startsWith('## ')) { out.push(`<h2>${inline(l.slice(3))}</h2>`); const n = l.match(/^## (\d+)\./)?.[1]; if (n && insertAfter[n]) out.push(insertAfter[n]); }
    else if (l.startsWith('### ')) out.push(`<h3>${inline(l.slice(4))}</h3>`);
    else if (l.startsWith('> ')) out.push(`<p class="callout">${inline(l.slice(2))}</p>`);
    else if (l.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      i--;
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('\n');
}

export function renderHtml(run, baseline = null) {
  const md = render(run, baseline);
  const insert = {
    3: deviationChart(run),
    4: latencyCharts(run),
    5: bottleneckCharts(run),
    6: baseline ? compareCharts(run, baseline) : '',
  };
  const body = mdToHtml(md, insert);
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>壓測報告 ${esc(run.meta.id)}</title>
<style>
:root{color-scheme:light;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--crit:#d03b3b;--q1:#cde2fb;--q2:#9ec5f4;--q3:#6da7ec;--q4:#2a78d6;--band:rgba(11,11,11,.04)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--q1:#104281;--q2:#1c5cab;--q3:#2a78d6;--q4:#5598e7;--band:rgba(255,255,255,.05)}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--q1:#104281;--q2:#1c5cab;--q3:#2a78d6;--q4:#5598e7;--band:rgba(255,255,255,.05)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif}
main{max-width:1160px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:8px 0 12px}h2{font-size:19px;margin:40px 0 12px;padding-top:16px;border-top:1px solid var(--grid)}h3{font-size:16px;margin:24px 0 8px}
p{margin:8px 0}.note{color:var(--ink2);font-size:13px}.callout{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:0 4px}
.table{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;background:var(--surface)}th,td{border:1px solid var(--grid);padding:6px 10px;text-align:left;vertical-align:top}th{color:var(--ink2);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.chart{margin:12px 0;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px}.chart figcaption{font-weight:600;font-size:14px;margin-bottom:6px}.chart svg{width:100%;height:auto;display:block;overflow:visible}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--ink2);margin-bottom:6px}.legend i{display:inline-block;width:14px;height:4px;border-radius:2px;margin-right:6px;vertical-align:middle}
svg .grid{stroke:var(--grid);stroke-width:1}svg .base{stroke:var(--axis);stroke-width:1}svg .ref{stroke:var(--crit);stroke-width:1;opacity:.6}svg .band{fill:var(--band)}
svg .axis{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}svg .label{fill:var(--ink2);font-size:12px}svg .mark{font-size:12px}
svg .dot{stroke:var(--surface);stroke-width:2}svg .hit{fill:transparent;cursor:crosshair;outline:none}svg .cell{stroke:none}svg .cell:hover,svg .cell:focus{opacity:.8;outline:none}
svg .cell-text{fill:var(--ink);font-size:11px;pointer-events:none}svg .cell-text-on{fill:#fff;font-size:11px;font-weight:600;pointer-events:none}
svg .cross{stroke:var(--axis);stroke-width:1;visibility:hidden;pointer-events:none}
details{margin:12px 0}summary{cursor:pointer;color:var(--ink2)}.hints{margin:8px 0;padding-left:20px}
#tip{position:fixed;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);display:none;z-index:9;max-width:320px}
#tip .t{color:var(--ink2);margin-bottom:4px}#tip .r{display:flex;align-items:center;gap:8px;white-space:nowrap}#tip .r b{font-variant-numeric:tabular-nums}#tip .k{width:12px;height:2px;border-radius:1px;flex:none}#tip .n{color:var(--ink2)}
@media (forced-colors:active){svg .cell{stroke:CanvasText}}
</style></head><body><main>
${body}
</main><div id="tip" role="tooltip"></div>
<script>
// 滑過或用 Tab 聚焦：顯示這個位置所有線的值（名稱用 textContent，不用 innerHTML）
const tipEl = document.getElementById('tip');
function show(el, cx, cy) {
  const d = JSON.parse(el.getAttribute('data-tip'));
  tipEl.replaceChildren();
  const t = document.createElement('div'); t.className = 't'; t.textContent = d.title; tipEl.append(t);
  for (const [color, value, name] of d.rows) {
    const r = document.createElement('div'); r.className = 'r';
    if (color) { const k = document.createElement('span'); k.className = 'k'; k.style.background = color; r.append(k); }
    const b = document.createElement('b'); b.textContent = value; const n = document.createElement('span'); n.className = 'n'; n.textContent = name;
    r.append(b, n); tipEl.append(r);
  }
  tipEl.style.display = 'block';
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  tipEl.style.left = Math.min(innerWidth - w - 8, cx + 14) + 'px';
  tipEl.style.top = Math.max(8, cy - h - 10) + 'px';
  const svg = el.ownerSVGElement, cross = svg && svg.querySelector('.cross');
  if (cross && el.classList.contains('hit') && el.getAttribute('height') > 40) {
    const x = +el.getAttribute('x') + +el.getAttribute('width') / 2;
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.visibility = 'visible';
  }
}
function hide(el) { tipEl.style.display = 'none'; const c = el.ownerSVGElement && el.ownerSVGElement.querySelector('.cross'); if (c) c.style.visibility = 'hidden'; }
for (const el of document.querySelectorAll('[data-tip]')) {
  el.addEventListener('pointermove', (e) => show(el, e.clientX, e.clientY));
  el.addEventListener('pointerleave', () => hide(el));
  el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); });
  el.addEventListener('blur', () => hide(el));
}
</script></body></html>`;
}
