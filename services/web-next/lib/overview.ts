import { unwrap, type CoreClient } from './core-client'

type Section = { ok: true; data: unknown } | { ok: false; error: 'temporarily_unavailable' }

/**
 * 會員中心總覽（§6.5）：一支 API 取代前台的「HTML → JS → token → 好幾支 API」瀑布。
 *  - 在伺服器端「平行」呼叫 core（同機房，延遲很低）
 *  - 每支有逾時預算（800 ms）；某一支失敗或太慢 → 只有那一塊顯示降級內容，整頁不會壞
 */
export async function buildOverview(core: CoreClient, a: { token: string; correlationId: string; name: string }) {
  const get = (path: string) => core.call<any>(path, { token: a.token, correlationId: a.correlationId, timeoutMs: 800 }).then(unwrap)

  const started = Date.now()
  const [orders, warehouse, subscriptions, cart] = await Promise.allSettled([
    get('/orders'), get('/warehouse'), get('/subscriptions'), get('/cart'),
  ])
  const section = <T>(r: PromiseSettledResult<T>, pick: (v: T) => unknown): Section => {
    if (r.status !== 'fulfilled') return { ok: false, error: 'temporarily_unavailable' }
    try {
      return { ok: true, data: pick(r.value) }
    } catch {
      return { ok: false, error: 'temporarily_unavailable' } // core 回的格式不對，也只降級這一塊
    }
  }

  return {
    customer: { name: a.name },
    recent_orders: section(orders, (v: any) => v.data.slice(0, 5)),
    warehouse: section(warehouse, (v: any) => v.data),
    subscriptions: section(subscriptions, (v: any) => v.data),
    cart_count: section(cart, (v: any) => v.items.length),
    took_ms: Date.now() - started,
  }
}
