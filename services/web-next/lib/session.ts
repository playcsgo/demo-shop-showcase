import { randomBytes } from 'node:crypto'
import { unwrap, type CoreClient } from './core-client'
import { HttpError } from './errors'
import { readCookie, SESSION_COOKIE } from './http'

export interface Session {
  sid: string
  customerId: number
  name: string
  email: string
  token: string    // core 簽的短效 JWT：只存在伺服器端，瀏覽器拿不到
  tokenExp: number // unix 秒
}

/** 只用到 Redis 的這三個指令：測試可以換成假的 */
export interface SessionRedis {
  get(key: string): Promise<string | null>
  set(...args: any[]): Promise<unknown>
  del(key: string): Promise<unknown>
}

const TTL_SECONDS = 7 * 86400

/**
 * 顧客 session 存在 Redis（§12.1：BFF 無狀態，換 Pod 不會登出）。
 * 瀏覽器只拿到隨機的 session id（httpOnly cookie）；就算有 XSS，也偷不到能直接呼叫 core 的 JWT。
 * 鍵（sess:<sid>）和內容格式跟 NestJS 版相同：兩個版本可以讀彼此建立的 session。
 */
export class SessionStore {
  constructor(private readonly redis: SessionRedis, private readonly core: CoreClient, private readonly serviceKey: string) {}

  async create(data: Omit<Session, 'sid'>): Promise<Session> {
    const session = { sid: randomBytes(32).toString('base64url'), ...data }
    await this.redis.set(`sess:${session.sid}`, JSON.stringify(session), 'EX', TTL_SECONDS)
    return session
  }

  async get(sid: string | undefined): Promise<Session | null> {
    if (!sid) return null
    const raw = await this.redis.get(`sess:${sid}`)
    return raw ? (JSON.parse(raw) as Session) : null
  }

  async destroy(sid: string): Promise<void> {
    await this.redis.del(`sess:${sid}`)
  }

  /** JWT 快過期（剩不到 60 秒）→ 用 BFF 的服務金鑰向 core 換新的（顧客不用重新登入） */
  async freshToken(session: Session, correlationId?: string): Promise<string> {
    if (session.tokenExp - Date.now() / 1000 > 60) return session.token

    const res = await this.core.call<{ access_token: string; expires_in: number }>('/auth/service-token', {
      method: 'POST', body: { customer_id: session.customerId }, headers: { 'x-service-key': this.serviceKey }, correlationId,
    })
    const data = unwrap(res)
    session.token = data.access_token
    session.tokenExp = Math.floor(Date.now() / 1000) + data.expires_in
    await this.redis.set(`sess:${session.sid}`, JSON.stringify(session), 'KEEPTTL')
    return session.token
  }
}

/**
 * 沒有有效的 session cookie → 401。
 * 這是 BFF 的「粗檢查」（有沒有登入）；「這筆訂單是不是你的」由 core 判斷（§8.3），BFF 不重複實作。
 */
export async function requireSession(headers: Headers, sessions: Pick<SessionStore, 'get'>): Promise<Session> {
  const session = await sessions.get(readCookie(headers, SESSION_COOKIE))
  if (!session) throw new HttpError(401, { error: 'unauthenticated' })
  return session
}
