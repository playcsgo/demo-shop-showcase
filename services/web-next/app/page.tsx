import { loadCatalog } from '@/lib/catalog'
import { logger } from '@/lib/log'
import { CatalogPage, type Product } from '@/ui/pages/CatalogPage.tsx'

// 每個請求都在伺服器產生 HTML（不在 build 時產生：build 的時候連不到 Redis 和 core）。
// 商品資料走 loadCatalog 的 Redis 快取（30 秒），所以產生頁面通常不用問 core
export const dynamic = 'force-dynamic'

/** 首頁（WEB-008）：商品在伺服器端取好，HTML 裡直接有商品名稱和價格，搜尋引擎和第一次進站的人不用等 JavaScript */
export default async function HomePage() {
  let products: Product[] = []
  try {
    products = (await loadCatalog()).data
  } catch (e) {
    // core 暫時連不上：照樣回頁面，商品由瀏覽器再抓一次（和 Vite 版相同的行為）
    logger.warn('catalog unavailable while rendering the home page', { err: (e as Error).message })
  }
  return <CatalogPage initial={products} />
}
