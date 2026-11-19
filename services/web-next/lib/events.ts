import { randomUUID } from 'node:crypto'
import type { Logger } from './log'

const ALLOWED = new Set(['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'])

export interface EventEntry { Id: string; MessageBody: string }
export type SendBatch = (entries: EventEntry[]) => Promise<void>

/**
 * 行為事件（§6.1）：前台用 sendBeacon 批次送來 → BFF 補上伺服器端資訊 → SQS analytics-events → 之後落地 S3／Redshift。
 * 和交易資料分開：分析事件掉了幾筆沒關係，訂單的 UTM 另外寫在 orders 表上（不依賴前端事件）。
 */
export function toEntries(body: { events?: Array<Record<string, any>> } | undefined, client: { sid?: string; userAgent?: string | null }): EventEntry[] {
  const events = (body?.events ?? []).filter((e) => ALLOWED.has(e?.name)).slice(0, 10) // SQS 一批最多 10 則
  return events.map((e) => ({
    Id: randomUUID().replace(/-/g, '').slice(0, 20),
    MessageBody: JSON.stringify({
      ...e,
      received_at: new Date().toISOString(),
      session_hash: client.sid ? Buffer.from(client.sid).toString('base64').slice(0, 12) : null, // 不存原始 session id
      user_agent: client.userAgent?.slice(0, 200),
    }),
  }))
}

export async function collectEvents(body: { events?: Array<Record<string, any>> } | undefined, client: { sid?: string; userAgent?: string | null }, send: SendBatch, log: Logger) {
  const entries = toEntries(body, client)
  if (entries.length === 0) return { accepted: 0 }
  try {
    await send(entries)
  } catch (e) {
    log.warn('analytics events dropped', { dropped: entries.length, err: (e as Error).message }) // 分析事件 best-effort，不影響使用者
  }
  return { accepted: entries.length }
}
