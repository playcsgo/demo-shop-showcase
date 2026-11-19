/**
 * debug log（M14）：一律輸出 JSON 到 stdout，收集交給外面（本機 Alloy→Loki、正式環境 Datadog Agent）。
 * 欄位和 NestJS 版相同：level、ts、service、correlation_id、msg。service 仍是 bff-gateway：
 * 這個 image 掛在 bff-gateway 的名稱下（WEB_RUNTIME=next），既有的看板和查詢不用改。
 */
const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const
type Level = keyof typeof LEVELS
type Fields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields): void
}

// 憑證、cookie、金鑰一律遮蔽，不進 log
const SECRET_KEYS = new Set(['authorization', 'cookie', 'set-cookie', 'x-internal-key', 'x-service-key', 'token', 'access_token', 'password', 'sid'])

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.has(k.toLowerCase()) ? '[Redacted]' : redact(v)]))
  }
  return value
}

export function createLogger(opts: { level?: string; write?: (line: string) => void } = {}): Logger {
  const min = LEVELS[(opts.level ?? 'info') as Level] ?? LEVELS.info
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const emit = (level: Level) => (msg: string, fields: Fields = {}) => {
    if (LEVELS[level] < min) return
    write(JSON.stringify({ level, ts: new Date().toISOString(), service: 'bff-gateway', ...(redact(fields) as Fields), msg }))
  }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}

export const logger = createLogger({ level: process.env.LOG_LEVEL })
