import { describe, expect, it, vi } from 'vitest'
import { CoreClient, unwrap } from './core-client'
import { HttpError } from './errors'

const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

describe('CoreClient', () => {
  it('打 core 的 /api/v1，帶 JWT、追蹤號碼和額外的 header', async () => {
    const fetchFn = vi.fn(async () => ok({ a: 1 }))
    const core = new CoreClient({ base: 'http://core', fetchFn })
    const r = await core.call('/cart/items', { method: 'PUT', token: 'JWT', correlationId: 'c-1', body: { q: 1 }, headers: { 'idempotency-key': 'k' } })

    expect(r).toEqual({ status: 200, data: { a: 1 } })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://core/api/v1/cart/items')
    expect(init.method).toBe('PUT')
    expect(init.body).toBe('{"q":1}')
    expect(init.headers).toMatchObject({ authorization: 'Bearer JWT', 'x-correlation-id': 'c-1', 'idempotency-key': 'k', accept: 'application/json' })
  })

  it('沒給 token 和追蹤號碼就不帶那兩個 header；沒有 body 就不送 body', async () => {
    const fetchFn = vi.fn(async () => ok({}))
    await new CoreClient({ base: 'http://core', fetchFn }).call('/catalog')
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect(init.headers).not.toHaveProperty('authorization')
    expect(init.headers).not.toHaveProperty('x-correlation-id')
  })

  it('core 連不上或逾時：503 core_unavailable', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const err = await new CoreClient({ base: 'http://core', fetchFn }).call('/catalog').catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(503)
    expect(err.body).toEqual({ error: 'core_unavailable' })
  })

  it('逾時用 AbortSignal，預設 5 秒，可以個別指定', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const core = new CoreClient({ base: 'http://core', fetchFn: vi.fn(async () => ok({})) })
    await core.call('/a')
    await core.call('/b', { timeoutMs: 800 })
    expect(spy.mock.calls.map((c) => c[0])).toEqual([5000, 800])
    spy.mockRestore()
  })

  it('core 回的不是 JSON：data 是空物件，狀態碼照舊', async () => {
    const core = new CoreClient({ base: 'http://core', fetchFn: vi.fn(async () => new Response('<html>', { status: 502 })) })
    expect(await core.call('/x')).toEqual({ status: 502, data: {} })
  })
})

describe('unwrap', () => {
  it('成功就回資料', () => expect(unwrap({ status: 201, data: { id: 1 } })).toEqual({ id: 1 }))

  it('core 的錯誤（狀態碼和內容）原樣丟出去', () => {
    const run = () => unwrap({ status: 422, data: { error: 'validation_failed', message: '數量不對' } })
    expect(run).toThrow(HttpError)
    try { run() } catch (e) {
      expect((e as HttpError).status).toBe(422)
      expect((e as HttpError).body).toEqual({ error: 'validation_failed', message: '數量不對' })
    }
  })
})
