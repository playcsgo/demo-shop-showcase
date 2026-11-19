import { describe, expect, it, vi } from 'vitest'
import type { CoreClient } from './core-client'
import { HttpError } from './errors'
import { requireSession, SessionStore, type Session } from './session'

function fakeRedis() {
  const data = new Map<string, string>()
  const calls: unknown[][] = []
  return {
    data, calls,
    get: async (k: string) => data.get(k) ?? null,
    set: async (...args: unknown[]) => { calls.push(args); data.set(args[0] as string, args[1] as string); return 'OK' },
    del: async (k: string) => { data.delete(k); return 1 },
  }
}
const coreWith = (call: (...a: any[]) => any) => ({ call: vi.fn(call) }) as unknown as CoreClient
const now = () => Math.floor(Date.now() / 1000)
const base = { customerId: 7, name: 'Alice', email: 'a@x.test', token: 'JWT-1' }

describe('SessionStore', () => {
  it('建立：隨機的 sid，存在 sess:<sid>，7 天過期，內容格式和 NestJS 版相同（兩個版本的登入狀態互通）', async () => {
    const redis = fakeRedis()
    const s = await new SessionStore(redis, coreWith(() => {}), 'key').create({ ...base, tokenExp: 123 })

    expect(s.sid).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes 的 base64url
    expect(redis.calls[0]).toEqual([`sess:${s.sid}`, expect.any(String), 'EX', 604800])
    expect(JSON.parse(redis.data.get(`sess:${s.sid}`)!)).toEqual({ sid: s.sid, customerId: 7, name: 'Alice', email: 'a@x.test', token: 'JWT-1', tokenExp: 123 })
  })

  it('每次建立的 sid 都不同', async () => {
    const store = new SessionStore(fakeRedis(), coreWith(() => {}), 'key')
    const a = await store.create({ ...base, tokenExp: 1 }); const b = await store.create({ ...base, tokenExp: 1 })
    expect(a.sid).not.toBe(b.sid)
  })

  it('讀取：有就回 session，沒有、沒帶 sid 都是 null；刪除後讀不到', async () => {
    const store = new SessionStore(fakeRedis(), coreWith(() => {}), 'key')
    const s = await store.create({ ...base, tokenExp: 1 })
    expect(await store.get(s.sid)).toEqual(s)
    expect(await store.get('nope')).toBeNull()
    expect(await store.get(undefined)).toBeNull()
    await store.destroy(s.sid)
    expect(await store.get(s.sid)).toBeNull()
  })

  it('JWT 還有超過 60 秒：直接用，不呼叫 core', async () => {
    const core = coreWith(() => { throw new Error('不該被呼叫') })
    const store = new SessionStore(fakeRedis(), core, 'key')
    const s: Session = { sid: 's', ...base, tokenExp: now() + 600 }
    expect(await store.freshToken(s, 'c')).toBe('JWT-1')
    expect(core.call).not.toHaveBeenCalled()
  })

  it('JWT 剩不到 60 秒：用服務金鑰向 core 換新的，存回去時不改過期時間（顧客不用重新登入）', async () => {
    const redis = fakeRedis()
    const core = coreWith(async () => ({ status: 200, data: { access_token: 'JWT-2', expires_in: 900 } }))
    const store = new SessionStore(redis, core, 'svc-key')
    const s: Session = { sid: 'sid-1', ...base, tokenExp: now() + 30 }

    expect(await store.freshToken(s, 'corr-1')).toBe('JWT-2')
    expect(core.call).toHaveBeenCalledWith('/auth/service-token', {
      method: 'POST', body: { customer_id: 7 }, headers: { 'x-service-key': 'svc-key' }, correlationId: 'corr-1',
    })
    const [key, value, flag] = redis.calls[0] as [string, string, string]
    expect([key, flag]).toEqual(['sess:sid-1', 'KEEPTTL'])
    const saved = JSON.parse(value)
    expect(saved.token).toBe('JWT-2')
    expect(saved.tokenExp).toBeGreaterThanOrEqual(now() + 899)
  })

  it('換新失敗（core 回 401）：錯誤原樣丟出去，舊的 session 不動', async () => {
    const redis = fakeRedis()
    const store = new SessionStore(redis, coreWith(async () => ({ status: 401, data: { error: 'invalid_service_key' } })), 'bad')
    const err = await store.freshToken({ sid: 's', ...base, tokenExp: now() }, 'c').catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(401)
    expect(redis.calls).toHaveLength(0)
  })
})

describe('requireSession', () => {
  const store = { get: vi.fn(async (sid?: string) => (sid === 'good' ? ({ sid: 'good', ...base, tokenExp: 1 } as Session) : null)) }

  it('有效的 sid cookie：拿到 session', async () => {
    expect((await requireSession(new Headers({ cookie: 'sid=good' }), store)).customerId).toBe(7)
  })

  it('沒有 cookie、sid 無效：401 unauthenticated', async () => {
    for (const h of [new Headers(), new Headers({ cookie: 'sid=bad' })]) {
      const err = await requireSession(h, store).catch((e) => e)
      expect(err.status).toBe(401)
      expect(err.body).toEqual({ error: 'unauthenticated' })
    }
  })
})
