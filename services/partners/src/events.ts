import { pino } from 'pino';
// 最近的事件紀錄（控制台顯示用）
export interface LogEntry {
  at: string;
  partner: string;
  kind: string;
  detail: string;
}

const log: LogEntry[] = [];
export const stats: Record<string, number> = {};

/** debug log（M14）：JSON 到 stdout，和其他服務同一種格式；控制台的「最近事件」是同一份資料 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'partners' },
  messageKey: 'msg',
  timestamp: () => `,"ts":"${new Date().toISOString()}"`, // 和 PHP 同一個欄位名
  formatters: { level: (label) => ({ level: label }) },
});

/** extra：correlation_id（hub 帶來的）、注入了什麼故障等，進 debug log 方便用 correlation_id 查 */
export function record(partner: string, kind: string, detail = '', extra: Record<string, unknown> = {}): void {
  const level = /fault|error|dropped|lost|expired|full/.test(kind) ? 'warn' : 'debug';
  logger[level]({ partner, kind, detail, ...extra }, `${partner} ${kind}`);
  log.unshift({ at: new Date().toISOString(), partner, kind, detail });
  if (log.length > 300) log.pop();
  const key = `${partner}.${kind}`;
  stats[key] = (stats[key] ?? 0) + 1;
}

export const recent = (n = 100) => log.slice(0, n);
export function clearLog(): void {
  log.length = 0;
  for (const k of Object.keys(stats)) delete stats[k];
}
