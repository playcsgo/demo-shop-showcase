import { describe, expect, it } from 'vitest'
import { createLogger } from './log'

const capture = (level?: string) => {
  const lines: string[] = []
  return { lines, log: createLogger({ level, write: (l) => lines.push(l) }) }
}

describe('logger', () => {
  it('一行 JSON：level、ts、service、msg，和 NestJS 版同樣的欄位名', () => {
    const { lines, log } = capture('info')
    log.info('hello', { correlation_id: 'c-1' })
    const o = JSON.parse(lines[0])
    expect(o).toMatchObject({ level: 'info', service: 'bff-gateway', correlation_id: 'c-1', msg: 'hello' })
    expect(o.ts).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it('低於 LOG_LEVEL 的不輸出', () => {
    const { lines, log } = capture('warn')
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e')
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error'])
  })

  it('憑證類的欄位一律遮蔽', () => {
    const { lines, log } = capture('info')
    log.info('x', { authorization: 'Bearer JWT', cookie: 'sid=1', token: 'JWT', nested: { 'x-service-key': 'k', ok: 1 } })
    expect(lines[0]).not.toContain('JWT')
    expect(lines[0]).not.toContain('sid=1')
    expect(JSON.parse(lines[0]).nested).toEqual({ 'x-service-key': '[Redacted]', ok: 1 })
  })
})
