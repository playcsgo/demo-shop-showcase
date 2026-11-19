import { describe, expect, it, vi } from 'vitest'
import { collectEvents, toEntries } from './events'

describe('toEntries', () => {
  it('只收允許的事件名稱，其他丟掉', () => {
    const entries = toEntries({ events: [{ name: 'page_view' }, { name: 'drop_table' }, { name: 'purchase' }, null as any] }, {})
    expect(entries.map((e) => JSON.parse(e.MessageBody).name)).toEqual(['page_view', 'purchase'])
  })

  it('一次最多 10 則（SQS 一批的上限）', () => {
    expect(toEntries({ events: Array.from({ length: 25 }, () => ({ name: 'page_view' })) }, {})).toHaveLength(10)
  })

  it('補上伺服器端資訊；session id 只存雜湊過的片段，不存原始值', () => {
    const [e] = toEntries({ events: [{ name: 'add_to_cart', sku: 'X' }] }, { sid: 'super-secret-session-id', userAgent: 'UA'.repeat(200) })
    const body = JSON.parse(e.MessageBody)
    expect(body).toMatchObject({ name: 'add_to_cart', sku: 'X' })
    expect(body.received_at).toMatch(/^\d{4}-/)
    expect(body.session_hash).toHaveLength(12)
    expect(e.MessageBody).not.toContain('super-secret-session-id')
    expect(body.user_agent).toHaveLength(200)
    expect(e.Id).toMatch(/^[0-9a-f]{20}$/)
  })

  it('沒登入：session_hash 是 null；沒有 events 或 body：空的', () => {
    expect(JSON.parse(toEntries({ events: [{ name: 'page_view' }] }, {})[0].MessageBody).session_hash).toBeNull()
    expect(toEntries({}, {})).toEqual([])
    expect(toEntries(undefined, {})).toEqual([])
  })
})

describe('collectEvents', () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }

  it('送進佇列，回報收了幾則', async () => {
    const send = vi.fn(async () => {})
    expect(await collectEvents({ events: [{ name: 'page_view' }, { name: 'nope' }] }, {}, send, log)).toEqual({ accepted: 1 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('沒有可收的事件：不呼叫佇列', async () => {
    const send = vi.fn(async () => {})
    expect(await collectEvents({ events: [{ name: 'nope' }] }, {}, send, log)).toEqual({ accepted: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('佇列掛掉：只記 log，照樣回成功（分析事件掉了不影響使用者）', async () => {
    const send = vi.fn(async () => { throw new Error('SQS down') })
    expect(await collectEvents({ events: [{ name: 'purchase' }] }, {}, send, log)).toEqual({ accepted: 1 })
    expect(log.warn).toHaveBeenCalled()
  })
})
