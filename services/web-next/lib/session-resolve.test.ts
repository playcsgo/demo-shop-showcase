import { describe, expect, it, vi } from 'vitest'
import { HttpError } from './errors'
import type { Session } from './session'
import { resolveSession } from './session-resolve'

// AI 客服（support）用：拿瀏覽器帶來的 sid 問「這是哪位客戶」（AIC-015）
const alice: Session = { sid: 'sid-alice', customerId: 1, name: 'Alice', email: 'alice@example.test', token: 'JWT', tokenExp: 9e9 }
const sessions = { get: vi.fn(async (sid?: string) => (sid === 'sid-alice' ? alice : null)) }
const run = (provided: string | undefined, body: unknown, key = 'support-key') => resolveSession({ expectedKey: key, providedKey: provided, body, sessions })

describe('resolveSession', () => {
  it('有效的 sid：回客戶 id、名字、email，不回 core 的 JWT', async () => {
    const r = await run('support-key', { sid: 'sid-alice' })
    expect(r).toEqual({ valid: true, customer_id: 1, name: 'Alice', email: 'alice@example.test' })
    expect(JSON.stringify(r)).not.toContain('JWT')
  })

  it('登出或亂打的 sid：valid false', async () => {
    expect(await run('support-key', { sid: 'nope' })).toEqual({ valid: false })
    expect(await run('support-key', {})).toEqual({ valid: false })
    expect(await run('support-key', undefined)).toEqual({ valid: false })
    expect(await run('support-key', { sid: 'x'.repeat(500) })).toEqual({ valid: false })
    expect(await run('support-key', { sid: 123 })).toEqual({ valid: false })
  })

  it('金鑰錯、沒帶、BFF 沒設定金鑰：401', async () => {
    for (const [provided, key] of [['wrong', 'support-key'], [undefined, 'support-key'], ['', '']] as const) {
      const err = await run(provided, { sid: 'sid-alice' }, key).catch((e) => e)
      expect(err).toBeInstanceOf(HttpError)
      expect(err.status).toBe(401)
      expect(err.body).toEqual({ error: 'invalid_service_key' })
    }
  })
})
