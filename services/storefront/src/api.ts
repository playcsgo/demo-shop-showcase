// 前台呼叫 BFF 的唯一入口。注意：這裡沒有任何 token —— 身分靠瀏覽器自動帶的 httpOnly cookie
// Vite 的 tsconfig 開了 erasableSyntaxOnly：不能用建構子參數屬性（public status），要寫成一般欄位
export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T = any>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
      ...init.headers,
    },
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.message ?? body.error ?? `HTTP ${res.status}`)
  return body as T
}

export const money = (n: number) => `NT$ ${n.toLocaleString('zh-TW')}`

// ───────── UTM 與行為事件（§6.1）─────────
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'] as const
export function captureUtm() {
  const q = new URLSearchParams(location.search)
  if (UTM_KEYS.some((k) => q.get(k))) {
    sessionStorage.setItem('utm', JSON.stringify(Object.fromEntries(UTM_KEYS.map((k) => [k, q.get(k)]))))
  }
}
export const currentUtm = (): Record<string, string | null> => JSON.parse(sessionStorage.getItem('utm') ?? '{}')

let queue: Array<Record<string, unknown>> = []
export function track(name: string, props: Record<string, unknown> = {}) {
  queue.push({ name, at: new Date().toISOString(), path: location.pathname, ...currentUtm(), ...props })
  if (queue.length >= 10) flush()
}
// 批次送：每 3 秒一次、離開頁面時用 sendBeacon（不擋住頁面關閉）
function flush() {
  if (queue.length === 0) return
  const body = JSON.stringify({ events: queue.splice(0, 10) })
  navigator.sendBeacon?.('/api/events', new Blob([body], { type: 'application/json' }))
}
setInterval(flush, 3000)
addEventListener('pagehide', flush)
