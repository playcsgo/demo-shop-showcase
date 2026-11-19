import { io, type Socket } from 'socket.io-client'

// 客服 API 的入口（AIC-018）。對話框跟商店同源，/support 由 vite proxy 轉給 support-api，
// 所以瀏覽器自動帶的 cookie（商店的 sid、客服的 support_customer）都到得了，不需要 CORS 或 token
const BASE = '/support'

export class SupportError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function supportApi<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new SupportError(res.status, body.message ?? `HTTP ${res.status}`)
  return body as T
}

export const supportPost = <T = any>(path: string, body: unknown = {}) =>
  supportApi<T>(path, { method: 'POST', body: JSON.stringify(body) })

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

export type Identity = { anonymous: true } | { anonymous: false; id: number; name: string }

export const assetUrl = (key: string) => `${BASE}/api/assets/${key}`

export const connectCustomer = (): Socket =>
  io('/customer', { path: `${BASE}/socket.io`, transports: ['websocket'], withCredentials: true })

export const emit = (socket: Socket, event: string, payload: unknown) =>
  socket.timeout(5000).emitWithAck(event, payload) as Promise<{ ok: boolean; error?: string }>

/** 同一則訊息可能從歷史紀錄和即時推送各來一次，推送的順序也不一定等於寫入順序：去重後照伺服器的序號排 */
export const mergeMessages = (list: Message[], incoming: Message) =>
  list.some((m) => m.id === incoming.id) ? list : [...list, incoming].sort((a, b) => a.seq - b.seq)

// 對話 id 存 sessionStorage（AC-58）：重新整理還在，關掉分頁就重新開始。who 記這段對話是誰開的
const KEY = 'support_chat'
export type Saved = { id: string; who: string; mode: 'ask' | 'human' }
export const loadSaved = (): Saved | null => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
  } catch {
    return null
  }
}
export const saveChat = (s: Saved | null) => {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s))
    else sessionStorage.removeItem(KEY)
  } catch {
    /* 無痕模式等情況存不了：頂多重新整理後重開 */
  }
}
export const whoOf = (i: Identity) => (i.anonymous ? 'anon' : `c${i.id}`)
