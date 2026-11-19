import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.ts'
import type { CatalogItem } from './types.ts'

type Setting = CatalogItem & { selected: boolean }

/** 勾選要顯示的商品。國家禁令在下單時才掃描 */
export function ShopItemsPage() {
  const { id } = useParams()
  const [settings, setSettings] = useState<Setting[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api<{ data: Setting[] }>(`/shops/${id}/item-settings`).then((r) => {
      setSettings(r.data)
      setSelected(new Set(r.data.filter((s) => s.selected).map((s) => s.product_id)))
    }).catch((e) => setError(e.message))
  }, [id])

  const toggle = (v: number) => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    setSelected(next)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaved(false)
    try {
      const r = await api<{ data: CatalogItem[] }>(`/shops/${id}/items`, {
        method: 'PUT',
        body: JSON.stringify({ product_ids: [...selected] }),
      })
      setSaved(true)
      const shown = new Set(r.data.map((i) => i.product_id))
      setSettings((list) => list?.map((s) => ({ ...s, selected: shown.has(s.product_id) })) ?? null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form onSubmit={save}>
      <p><Link to={`/shops/${id}`}>← 回到這個 shop</Link></p>
      <h1>設定要顯示的商品</h1>
      <p className="muted">只能從合約允許的商品裡選。要加新商品請聯絡負責的業務。</p>
      <div className="cards">
        {settings?.map((s) => (
          <div className="card" key={s.product_id}>
            <label style={{ display: 'flex', gap: 8 }}>
              <input type="checkbox" checked={selected.has(s.product_id)} onChange={() => toggle(s.product_id)} />
              <span>{s.name}<span className="muted">（{s.sku}）</span></span>
            </label>
          </div>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {saved && <p className="toast">已存檔</p>}
      <p><button className="primary">存檔</button></p>
    </form>
  )
}
