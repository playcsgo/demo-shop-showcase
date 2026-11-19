import { io, type Socket } from 'socket.io-client'

// 呼叫客服 API 的唯一入口。這裡沒有 token：身分靠瀏覽器自動帶的 HttpOnly cookie
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.message ?? `HTTP ${res.status}`)
  return body as T
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) })

export interface Message {
  id: string
  seq: number
  conversation_id: string
  sender: 'customer' | 'agent' | 'ai' | 'system'
  visibility: 'public' | 'internal'
  body: string
  refs_json?: Record<string, unknown> | null
  attachment_key?: string | null
  created_at: string
}

export interface Ack {
  ok: boolean
  error?: string
}

export const connect = (ns: '/customer' | '/staff'): Socket => io(ns, { transports: ['websocket'], withCredentials: true })

export const emit = (socket: Socket, event: string, payload: unknown) => socket.timeout(5000).emitWithAck(event, payload) as Promise<Ack>

/**
 * 同一則訊息可能從歷史紀錄和即時推送各來一次；推送的到達順序也不一定等於寫入順序，
 * 所以去重後照伺服器的序號排
 */
export const mergeMessages = (list: Message[], incoming: Message) =>
  list.some((m) => m.id === incoming.id) ? list : [...list, incoming].sort((a, b) => a.seq - b.seq)
