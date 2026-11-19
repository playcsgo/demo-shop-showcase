import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.ts'
import { useB2b } from './B2bApp.tsx'
import { type CatalogItem, formatMoney, type Shop } from './types.ts'

export function ShopCatalogPage() {
  const { id } = useParams()
  const { me } = useB2b()
  const [shop, setShop] = useState<Shop | null>(null)
  const [items, setItems] = useState<CatalogItem[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api<Shop>(`/shops/${id}`).then(setShop).catch((e) => setError(e.message))
    api<{ data: CatalogItem[] }>(`/shops/${id}/catalog`).then((r) => setItems(r.data)).catch((e) => setError(e.message))
  }, [id])

  return (
    <>
      <p><Link to="/">← 回到總覽</Link></p>
      <h1>{shop?.name}</h1>
      {error && <p className="error">{error}</p>}
      {me?.role === 'manager' && <p><Link to={`/shops/${id}/items`}>設定要顯示的商品</Link></p>}
      {items?.length === 0 && <p className="muted">這個 shop 還沒有可以買的商品。</p>}
      {!!items?.length && (
        <table>
          <thead><tr><th>商品</th><th>每箱</th><th>MOQ</th><th>階梯價</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.product_id}>
                <td>{i.name}<div className="muted">{i.sku}．{i.temperature_class}</div></td>
                <td>{i.case_size} 件{i.case_multiple > 1 && <div className="muted">{i.case_multiple} 箱的倍數</div>}</td>
                <td>{i.moq_cases} 箱</td>
                <td>{i.tiers.map((t) => <div key={t.min_cases}>{t.min_cases} 箱以上 {formatMoney(t.unit_price_minor, me?.distributor.currency ?? 'USD')}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
