import { describe, expect, it, vi } from 'vitest'
import { HttpError } from './errors'
import { clearSessionCookie, correlationIdOf, readCookie, route, sessionCookie } from './http'

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const req = (init: RequestInit & { url?: string } = {}) => new Request(init.url ?? 'http://shop.test/api/x', init)

describe('correlationIdOf', () => {
  it('沿用上游帶來的號碼', () => expect(correlationIdOf(new Headers({ 'x-correlation-id': 'abc' }))).toBe('abc'))
  it('太長只取前 64 個字', () => expect(correlationIdOf(new Headers({ 'x-correlation-id': 'x'.repeat(100) }))).toBe('x'.repeat(64)))
  it('沒帶就產生一個 UUID', () => expect(correlationIdOf(new Headers())).toMatch(/^[0-9a-f-]{36}$/))
})

describe('route', () => {
  it('回應帶 x-correlation-id，handler 拿得到同一個號碼', async () => {
    const handler = route(async (ctx) => Response.json({ corr: ctx.correlationId }), { log: silent })
    const res = await handler(req({ headers: { 'x-correlation-id': 'c-9' } }), { params: Promise.resolve({}) })
    expect(res.headers.get('x-correlation-id')).toBe('c-9')
    expect(await res.json()).toEqual({ corr: 'c-9' })
  })

  it('HttpError：狀態碼和內容照丟出來的回', async () => {
    const handler = route(async () => { throw new HttpError(401, { error: 'unauthenticated' }) }, { log: silent })
    const res = await handler(req(), { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
    expect(res.headers.get('x-correlation-id')).toBeTruthy()
  })

  it('沒預期到的錯誤：500，內容不洩漏細節（和 NestJS 版同一個格式）', async () => {
    const handler = route(async () => { throw new Error('redis password is hunter2') }, { log: silent })
    const res = await handler(req(), { params: Promise.resolve({}) })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ statusCode: 500, message: 'Internal server error' })
  })

  it('ctx.json()：壞掉的 JSON 回 400；沒有 body 是 undefined', async () => {
    const handler = route(async (ctx) => Response.json({ body: (await ctx.json()) ?? null }), { log: silent })
    const bad = await handler(req({ method: 'POST', body: '{oops', headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({}) })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'Bad Request', statusCode: 400 })

    const empty = await handler(req({ method: 'POST' }), { params: Promise.resolve({}) })
    expect(await empty.json()).toEqual({ body: null })
  })

  it('每個請求記一行 log：方法、路徑、狀態碼、追蹤號碼；/health 以外都記', async () => {
    const log = { ...silent, info: vi.fn() }
    await route(async () => new Response(null, { status: 204 }), { log })(req({ url: 'http://shop.test/api/cart?x=1', headers: { 'x-correlation-id': 'c-1' } }), { params: Promise.resolve({}) })
    const [msg, fields] = log.info.mock.calls[0]
    expect(msg).toMatch(/^GET \/api\/cart\?x=1 → 204 \(\d+ ms\)$/)
    expect(fields).toMatchObject({ correlation_id: 'c-1', req: { method: 'GET', url: '/api/cart?x=1' }, res: { status: 204 } })
  })

  it('params 傳給 handler', async () => {
    const handler = route<{ id: string }>(async (ctx) => Response.json(ctx.params), { log: silent })
    expect(await (await handler(req(), { params: Promise.resolve({ id: '7' }) })).json()).toEqual({ id: '7' })
  })
})

describe('cookie', () => {
  it('讀 cookie', () => {
    expect(readCookie(new Headers({ cookie: 'a=1; sid=abc-DEF_9; b=2' }), 'sid')).toBe('abc-DEF_9')
    expect(readCookie(new Headers(), 'sid')).toBeUndefined()
  })

  it('登入的 cookie：httpOnly、SameSite=Lax、path=/、7 天；Secure 預設不加', () => {
    const c = sessionCookie('SID', false)
    expect(c).toMatch(/^sid=SID;/)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Path=/')
    expect(c).toContain('Max-Age=604800')
    expect(c).not.toContain('Secure')
    expect(sessionCookie('SID', true)).toContain('Secure')
  })

  it('登出：把 cookie 設成過期', () => {
    expect(clearSessionCookie()).toMatch(/^sid=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/)
  })
})
