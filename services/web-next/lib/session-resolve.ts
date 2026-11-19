import { timingSafeEqual } from 'node:crypto'
import { HttpError } from './errors'
import type { SessionStore } from './session'

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * AI 客服（support）用（AIC-015）：瀏覽器打 support 時會帶商店的 sid cookie（同網域），support 拿它來問「這是哪位客戶」。
 * sid 放 body 不放網址（網址會進 access log）；只回 id、名字、email，不回 core 的 JWT：support 查資料用自己的服務金鑰。
 */
export async function resolveSession(a: { expectedKey: string; providedKey: string | undefined | null; body: unknown; sessions: Pick<SessionStore, 'get'> }) {
  if (!a.expectedKey || !same(a.expectedKey, a.providedKey ?? '')) throw new HttpError(401, { error: 'invalid_service_key' })
  const raw = (a.body as { sid?: unknown } | undefined)?.sid
  const sid = typeof raw === 'string' && raw.length <= 100 ? raw : undefined
  const session = sid ? await a.sessions.get(sid) : null
  return session
    ? { valid: true, customer_id: session.customerId, name: session.name, email: session.email }
    : { valid: false }
}
