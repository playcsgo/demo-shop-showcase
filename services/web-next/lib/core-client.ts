import { HttpError } from './errors'
import { logger, type Logger } from './log'

export interface CoreResponse<T = any> { status: number; data: T }

export interface CallOptions {
  method?: string
  token?: string
  body?: unknown
  headers?: Record<string, string>
  correlationId?: string
  timeoutMs?: number
}

/**
 * 呼叫 core-api 的唯一入口：逾時、帶 JWT、帶 correlation id、統一錯誤格式。
 * BFF 是「防腐層」：core 的網址或格式改了，只要改這裡和對應的 route，前台不用動。
 * 不依賴 Next.js：Route Handler 和伺服器端產生的頁面都用這一個（頁面不繞一圈 HTTP 打自己）。
 */
export class CoreClient {
  private readonly base: string
  private readonly fetchFn: typeof fetch
  private readonly log: Logger

  constructor(opts: { base?: string; fetchFn?: typeof fetch; log?: Logger } = {}) {
    this.base = opts.base ?? process.env.CORE_URL ?? 'http://core-nginx'
    this.fetchFn = opts.fetchFn ?? fetch
    this.log = opts.log ?? logger
  }

  async call<T = any>(path: string, opts: CallOptions = {}): Promise<CoreResponse<T>> {
    const started = Date.now()
    const method = opts.method ?? 'GET'
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}/api/v1${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.correlationId ? { 'x-correlation-id': opts.correlationId } : {}),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        cache: 'no-store', // Next.js 會包裝 fetch；轉發的請求一律不快取
      })
    } catch (e) {
      this.log.warn(`core ${path} unreachable`, { path, err: (e as Error).message, correlation_id: opts.correlationId })
      throw new HttpError(503, { error: 'core_unavailable' })
    }
    const data = (await res.json().catch(() => ({}))) as T
    this.log.debug(`core ${method} ${path} → ${res.status}`, { method, path, status: res.status, ms: Date.now() - started, correlation_id: opts.correlationId })
    return { status: res.status, data }
  }
}

/** 把 core 的結果原封不動回給前台（包含錯誤狀態碼與 {error, message}） */
export function unwrap<T>(r: CoreResponse<T>): T {
  if (r.status >= 400) throw new HttpError(r.status, r.data)
  return r.data
}
