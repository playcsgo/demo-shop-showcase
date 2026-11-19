// 壓測的命名：資料夾名稱、sandbox 的工作名稱都從「實際用的設定」產生，不靠手打
// （手打的說明寫錯過：名稱寫完美世界、8 桶，實際跑的是真實世界、1 桶 → 拿去跟別輪比就比錯了）
//
//   資料夾：<時間>-<模式>-<世界>-b<桶數>-logi<on|off>-<fpm|octane|go>-L<第一階>to<最後一階>[-<說明>]
//   例：20261015-1600-k8s-max-perfect-b8-logioff-octane-L5to80-retry

export const WORLD_SHORT = { perfect: 'perfect', realistic: 'real' };
const WORLD_LABEL = { perfect: '完美世界', realistic: '真實世界' };
const RUNTIME_LABEL = { fpm: 'PHP-FPM', octane: 'Octane（Swoole）', go: 'Go' };

const levelsOf = (levels) => String(levels).split(',').map((x) => x.trim()).filter(Boolean);

/** 設定 → 英數字的名稱片段（資料夾用：中文路徑在連結、指令裡容易出問題） */
export function configSlug({ mode, worlds, buckets, logisticsCallbacks, runtime, levels, directOnly = true, ratio = 0 }) {
  const lv = levelsOf(levels);
  return [
    mode,
    String(worlds).split(',').map((w) => WORLD_SHORT[w] ?? w).join('_'),
    `b${buckets}`,
    `logi${logisticsCallbacks ? 'on' : 'off'}`,
    runtime ?? 'unknown',
    lv.length > 1 ? `L${lv[0]}to${lv.at(-1)}` : `L${lv[0]}`,
    directOnly ? null : 'mix',
    Number(ratio) ? `q${ratio}` : null,
  ].filter(Boolean).join('-');
}

/** 手打的說明 → 名稱片段（只留英數字；中文說明完整寫在報告裡） */
export const noteSlug = (note) => String(note ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

/** 資料夾名稱 */
export function runId(stamp, config, note) {
  return [stamp, configSlug(config), noteSlug(note)].filter(Boolean).join('-');
}

/** 給人看的設定摘要（sandbox 的工作名稱、報告標題） */
export function configLabel({ modeLabel, worlds, buckets, logisticsCallbacks, runtime, levels }) {
  return [
    modeLabel,
    String(worlds).split(',').map((w) => WORLD_LABEL[w] ?? w).join('＋'),
    `庫存 ${buckets} 桶`,
    `物流回呼${logisticsCallbacks ? '開' : '關'}`,
    RUNTIME_LABEL[runtime] ?? runtime ?? '執行方式不明',
    `每秒 ${levelsOf(levels).join(',')} 筆`,
  ].join('｜');
}

export const runtimeLabel = (runtime) => RUNTIME_LABEL[runtime] ?? runtime ?? '不明';

/**
 * core-api 的「忙／上限／排隊」（取樣的 fpm 欄位）在報告上怎麼稱呼：同一組數字，不同執行方式意思不一樣
 *   fpm：PHP-FPM 的 worker（舊的報告沒記錄執行方式，當時都是 FPM）
 *   go：Go 沒有 worker 池，/fpm-status 回報的是資料庫連線池（使用中／上限／還沒拿到連線的請求，services/core-go/api.go）
 *   octane：沒有 FPM，取樣拿不到
 */
export function apiPool(runtime) {
  if (runtime === 'go') {
    return {
      name: 'Go 資料庫連線', row: 'core-api（Go）資料庫連線 使用中／上限', rowQueue: 'core-api（Go）資料庫連線 使用中／上限（等連線）', heat: 'Go 資料庫連線',
      full: (busy, max, queue) => `core-api（Go）資料庫連線 ${busy}／${max} 用滿${queue ? `、${queue} 個請求在等連線` : ''}`,
      waiting: (busy, per) => `core-api（Go）${busy} 條資料庫連線全用滿，平均每條只對應 ${per} 顆 CPU：Go 在等資料庫（鎖、查詢），不是算不完`,
      process: 'core-api（Go）',
    };
  }
  return {
    name: 'PHP-FPM', row: 'PHP-FPM 忙／上限', rowQueue: 'PHP-FPM 忙／上限（排隊）', heat: 'PHP-FPM 忙',
    full: (busy, max, queue) => `PHP-FPM ${busy}／${max} 全忙${queue ? `、${queue} 個請求在排隊` : ''}`,
    waiting: (busy, per) => `PHP-FPM ${busy} 個 worker 全忙，平均每個只用 ${per} 顆 CPU：PHP 在等東西（鎖、資料庫、外部呼叫），不是算不完`,
    process: 'core-api（PHP-FPM）',
  };
}
