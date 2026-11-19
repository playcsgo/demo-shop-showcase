// 呼叫經銷商 API 的唯一入口。這裡沒有 token：身分靠瀏覽器自動帶的 HttpOnly session cookie
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
  const res = await fetch(`/api/v1/b2b${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
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
