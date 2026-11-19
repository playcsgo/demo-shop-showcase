import { unwrap } from './core-client'
import { deps } from './deps'

/**
 * 商品目錄：人人相同 → BFF 再快取 30 秒（core 那邊還有 Redis 5 分鐘）。價格以結帳時 core 重算為準。
 * /api/catalog 和伺服器端產生的首頁都用這一個；快取鍵和 NestJS 版相同（內容也相同）。
 */
export async function loadCatalog(correlationId?: string): Promise<any> {
  const { redis, core } = deps()
  const cached = await redis.get('bff:catalog')
  if (cached) return JSON.parse(cached)
  const data = unwrap(await core.call('/catalog', { correlationId }))
  await redis.set('bff:catalog', JSON.stringify(data), 'EX', 30)
  return data
}
