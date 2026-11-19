import { randomUUID } from 'node:crypto'
import { HttpError } from './errors'
import { logger, type Logger } from './log'

export const SESSION_COOKIE = 'sid'
const SESSION_MAX_AGE = 7 * 86400

/** 每個請求一個 correlation id：沿用上游帶來的（最多 64 字），沒有就產生。往下帶給 core，一路寫進 outbox、SQS、hub 的 log */
export function correlationIdOf(headers: Headers): string {
  return (headers.get('x-correlation-id') ?? '').slice(0, 64) || randomUUID()
}

export function readCookie(headers: Headers, name: string): string | undefined {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

/** 瀏覽器只拿到 session 編號：JavaScript 讀不到（HttpOnly）、跨站的表單 POST 不會帶（SameSite=Lax）；正式環境（HTTPS）加 Secure */
export function sessionCookie(sid: string, secure: boolean): string {
  const expires = new Date(Date.now() + SESSION_MAX_AGE * 1000).toUTCString()
  return `${SESSION_COOKIE}=${sid}; Max-Age=${SESSION_MAX_AGE}; Path=/; Expires=${expires}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax`
}

export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`

export interface RouteContext<P = Record<string, string>> {
  req: Request
  correlationId: string
  params: P
  /** 請求的 JSON body：沒有 body 回 undefined；壞掉的 JSON 丟 400 */
  json<T = unknown>(): Promise<T | undefined>
}

type NextRouteArg<P> = { params: Promise<P> }

/**
 * 每一支 Route Handler 都包這一層（對應 NestJS 版的 middleware＋exception filter＋pino-http）：
 * 決定追蹤號碼、把錯誤轉成 JSON、回應帶 x-correlation-id、記一行請求 log。
 */
export function route<P = Record<string, string>>(
  handler: (ctx: RouteContext<P>) => Promise<Response>,
  opts: { log?: Logger } = {},
) {
  const log = opts.log ?? logger
  return async (req: Request, arg: NextRouteArg<P>): Promise<Response> => {
    const started = Date.now()
    const correlationId = correlationIdOf(req.headers)
    const url = new URL(req.url)
    const path = url.pathname + url.search

    let res: Response
    try {
      res = await handler({
        req,
        correlationId,
        params: await arg.params,
        json: async <T>() => {
          const text = await req.text()
          if (text === '') return undefined
          try {
            return JSON.parse(text) as T
          } catch (e) {
            throw new HttpError(400, { message: (e as Error).message, error: 'Bad Request', statusCode: 400 })
          }
        },
      })
    } catch (e) {
      if (e instanceof HttpError) {
        res = Response.json(e.body, { status: e.status })
      } else {
        log.error('unhandled error', { correlation_id: correlationId, err: (e as Error).message, stack: (e as Error).stack })
        res = Response.json({ statusCode: 500, message: 'Internal server error' }, { status: 500 })
      }
    }

    res.headers.set('x-correlation-id', correlationId)
    if (url.pathname !== '/health') {
      const ms = Date.now() - started
      log.info(`${req.method} ${path} → ${res.status} (${ms} ms)`, {
        correlation_id: correlationId, req: { method: req.method, url: path }, res: { status: res.status }, responseTime: ms,
      })
    }
    return res
  }
}
