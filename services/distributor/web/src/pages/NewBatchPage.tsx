import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.ts'
import { BatchSummary } from './BatchSummary.tsx'
import { type Batch, type CatalogItem, type Priced, type Shop } from './types.ts'

type ShopRow = { shop: Shop; catalog: CatalogItem[] }

/** 選類型 → 填各 shop 的箱數 → 看金額和警告 → 送出。金額都由 core 算，這裡不算價。網址有 batchNo 就是退回後編輯重送 */
export function NewBatchPage() {
  const navigate = useNavigate()
  const { batchNo } = useParams()
  const [rows, setRows] = useState<ShopRow[]>([])
  const [type, setType] = useState<'stock' | 'early_bird'>('stock')
  const [qty, setQty] = useState<Record<string, string>>({})       // "shopId:productId" → 箱數
  const [dates, setDates] = useState<Record<number, string>>({})   // shopId → 交期
  const [preview, setPreview] = useState<Priced | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const idempotencyKey = useRef(crypto.randomUUID())

  useEffect(() => {
    api<{ data: Shop[] }>('/shops').then(async (r) => {
      setRows(await Promise.all(r.data.map(async (shop) => ({ shop, catalog: (await api<{ data: CatalogItem[] }>(`/shops/${shop.id}/catalog`)).data }))))
    }).catch((e) => setError(e.message))
    if (batchNo) {
      api<Batch>(`/batches/${batchNo}`).then((b) => {
        setType(b.order_type)
        setQty(Object.fromEntries(b.orders.flatMap((o) => o.items.map((i) => [`${o.shop_id}:${i.product_id}`, String(i.qty_cases)]))))
        setDates(Object.fromEntries(b.orders.filter((o) => o.requested_ship_date).map((o) => [o.shop_id, o.requested_ship_date!])))
      }).catch((e) => setError(e.message))
    }
  }, [batchNo])

  function payload() {
    const orders = rows.map(({ shop, catalog }) => ({
      shop_id: shop.id,
      requested_ship_date: type === 'early_bird' ? dates[shop.id] || null : null,
      items: catalog.filter((c) => Number(qty[`${shop.id}:${c.product_id}`]) > 0)
        .map((c) => ({ product_id: c.product_id, qty_cases: Number(qty[`${shop.id}:${c.product_id}`]) })),
    })).filter((o) => o.items.length > 0)
    return { order_type: type, orders }
  }

  function changed() { setPreview(null); setError('') }

  async function runPreview() {
    setError('')
    setBusy(true)
    try {
      setPreview(await api<Priced>('/batches/preview', { method: 'POST', body: JSON.stringify(payload()) }))
    } catch (e) {
      setPreview(null)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    setError('')
    setBusy(true)
    try {
      const batch = batchNo
        ? await api<Batch>(`/batches/${batchNo}`, { method: 'PUT', body: JSON.stringify(payload()) })
        : await api<Batch>('/batches', { method: 'POST', idempotencyKey: idempotencyKey.current, body: JSON.stringify(payload()) })
      navigate(`/batches/${batch.batch_no}`)
    } catch (e) {
      idempotencyKey.current = crypto.randomUUID()   // 失敗沒有留下資料：改完再送是新的一次
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      <h1>{batchNo ? `重新送出 ${batchNo}` : '新增叫貨'}</h1>
      <label>類型
        <select value={type} onChange={(e) => { setType(e.target.value as 'stock' | 'early_bird'); changed() }}>
          <option value="stock">現貨（直接拉庫存）</option>
          <option value="early_bird">早鳥（排產，享折扣，交期要夠遠）</option>
        </select>
      </label>
      <div className="cards">
        {rows.map(({ shop, catalog }) => (
          <div className="card" key={shop.id}>
            <h3>{shop.name}</h3>
            {type === 'early_bird' && (
              <label>交期
                <input type="date" value={dates[shop.id] ?? ''} onChange={(e) => { setDates({ ...dates, [shop.id]: e.target.value }); changed() }} />
              </label>
            )}
            {catalog.length === 0 && <p className="muted">這個 shop 還沒有可以買的商品。</p>}
            {catalog.map((c) => (
              <label key={c.product_id}>{c.name}（{c.sku}，每箱 {c.case_size} 件{c.case_multiple > 1 ? `，${c.case_multiple} 箱的倍數` : ''}）
                <input type="number" min={0} step={c.case_multiple} value={qty[`${shop.id}:${c.product_id}`] ?? ''} placeholder="箱數"
                  onChange={(e) => { setQty({ ...qty, [`${shop.id}:${c.product_id}`]: e.target.value }); changed() }} />
              </label>
            ))}
          </div>
        ))}
      </div>
      <p><button onClick={runPreview} disabled={busy || payload().orders.length === 0}>看金額</button></p>
      {error && <p className="error">{error}</p>}
      {preview && (
        <>
          <BatchSummary orders={preview.orders} currency={preview.currency} total={preview.total_minor} prepay={preview.prepay_minor}
            prepayBps={preview.prepay_bps} moq={preview.moq_results} warnings={preview.warnings} />
          {!!preview.stock_shortages?.length && <p className="error">目前庫存不足：{preview.stock_shortages.join('、')}。可以減少數量或改下早鳥單。</p>}
          <p><button className="primary" onClick={submit} disabled={busy}>送出</button></p>
        </>
      )}
    </>
  )
}
