import { describe, expect, it, vi } from 'vitest'
import type { CoreClient } from './core-client'
import { HttpError } from './errors'
import { buildOverview } from './overview'

function coreWith(responses: Record<string, { status: number; data: any } | Error>) {
  return { call: vi.fn(async (path: string) => { const r = responses[path]; if (r instanceof Error) throw r; return r }) } as unknown as CoreClient
}
const args = { token: 't', correlationId: 'corr', name: 'Alice' }

describe('buildOverview', () => {
  it('4 支都成功：每一塊都有資料；訂單只取前 5 筆', async () => {
    const core = coreWith({
      '/orders': { status: 200, data: { data: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ order_no: `A${n}` })) } },
      '/warehouse': { status: 200, data: { data: [{ name: '狗糧', balance: 10 }] } },
      '/subscriptions': { status: 200, data: { data: [] } },
      '/cart': { status: 200, data: { items: [1, 2] } },
    })
    const r = await buildOverview(core, args)
    expect(r.customer).toEqual({ name: 'Alice' })
    expect((r.recent_orders as any).data).toHaveLength(5)
    expect(r.warehouse).toEqual({ ok: true, data: [{ name: '狗糧', balance: 10 }] })
    expect(r.cart_count).toEqual({ ok: true, data: 2 })
    expect(typeof r.took_ms).toBe('number')
  })

  it('寄倉 API 掛掉（503）、訂閱逾時：只有那兩塊降級，其他照常顯示', async () => {
    const r = await buildOverview(coreWith({
      '/orders': { status: 200, data: { data: [] } },
      '/warehouse': { status: 503, data: { error: 'down' } },
      '/subscriptions': new HttpError(503, { error: 'core_unavailable' }),
      '/cart': { status: 200, data: { items: [] } },
    }), args)
    expect(r.recent_orders.ok).toBe(true)
    expect(r.warehouse).toEqual({ ok: false, error: 'temporarily_unavailable' })
    expect(r.subscriptions).toEqual({ ok: false, error: 'temporarily_unavailable' })
    expect(r.cart_count.ok).toBe(true)
  })

  it('4 支平行呼叫，每支的逾時預算是 800 ms，都帶 JWT 和追蹤號碼', async () => {
    const core = coreWith({})
    await buildOverview(core, args)
    const calls = (core.call as any).mock.calls
    expect(calls.map((c: any[]) => c[0]).sort()).toEqual(['/cart', '/orders', '/subscriptions', '/warehouse'])
    for (const c of calls) expect(c[1]).toEqual({ token: 't', correlationId: 'corr', timeoutMs: 800 })
  })
})
