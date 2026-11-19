import { useEffect, useState } from 'react'
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, money } from '../api.ts'
import { useMe } from '../App.tsx'
import { FulfillmentCards, type OrderDetail } from '../components/FulfillmentCards.tsx'

/** 會員中心：React Router 換頁，不整頁重載（對照電商實測：選單是整頁重載＋301 轉址） */
export function MemberPage() {
  const { me, setMe } = useMe()
  const navigate = useNavigate()
  if (!me) return <div className="sheet"><p>請先 <Link to="/login">登入</Link></p></div>

  async function logout() {
    await api('/auth/logout', { method: 'POST' })
    setMe(null)
    navigate('/')
  }

  return (
    <div className="sheet member">
      <aside>
        <NavLink end to="/me">總覽</NavLink>
        <NavLink to="/me/orders">訂單</NavLink>
        <NavLink to="/me/warehouse">寄倉</NavLink>
        <button className="link" onClick={logout}>登出</button>
      </aside>
      <section>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="orders" element={<Orders />} />
          <Route path="orders/:orderNo" element={<MemberOrder />} />
          <Route path="warehouse" element={<Warehouse />} />
        </Routes>
      </section>
    </div>
  )
}

type Section<T> = { ok: true; data: T } | { ok: false; error: string }
type OverviewData = {
  customer: { name: string }; took_ms: number
  recent_orders: Section<Array<{ order_no: string; status: string; total: number }>>
  warehouse: Section<Array<{ variant_id: number; name: string; balance: number }>>
  subscriptions: Section<Array<{ id: number; product: string; status: string; cycles_done: number; total_cycles: number }>>
  cart_count: Section<number>
}

/** 一支 /api/me/overview 拿到整頁資料；某一塊失敗只影響那一塊 */
function Overview() {
  const [d, setD] = useState<OverviewData | null>(null)
  useEffect(() => { api<OverviewData>('/me/overview').then(setD) }, [])
  if (!d) return <p>載入中…</p>
  const block = <T,>(s: Section<T>, render: (v: T) => React.ReactNode) => s.ok ? render(s.data) : <p className="muted">暫時無法顯示</p>

  return (
    <>
      <h1>{d.customer.name} 的會員中心</h1>
      <p className="muted">BFF 在伺服器端平行取 4 支 API，共 {d.took_ms} ms</p>
      <div className="overview">
        <div><h3>最近訂單</h3>{block(d.recent_orders, (rows) => rows.length === 0 ? <p>還沒有訂單</p> :
          <ul>{rows.map((o) => <li key={o.order_no}><Link to={`/me/orders/${o.order_no}`}>{o.order_no}</Link> {o.status} <span className="price">{money(o.total)}</span></li>)}</ul>)}</div>
        <div><h3>寄倉餘額</h3>{block(d.warehouse, (rows) => rows.length === 0 ? <p>沒有寄倉商品</p> :
          <ul>{rows.map((w) => <li key={w.variant_id}>{w.name}：{w.balance}</li>)}</ul>)}</div>
        <div><h3>訂閱</h3>{block(d.subscriptions, (rows) => rows.length === 0 ? <p>沒有訂閱</p> :
          <ul>{rows.map((s) => <li key={s.id}>{s.product} {s.status}（{s.cycles_done}／{s.total_cycles} 期）</li>)}</ul>)}</div>
        <div><h3>購物車</h3>{block(d.cart_count, (n) => <p><Link to="/cart">{n} 項商品</Link></p>)}</div>
      </div>
    </>
  )
}

function Orders() {
  const [rows, setRows] = useState<Array<{ order_no: string; status: string; total: number; created_at: string }>>([])
  useEffect(() => { api<{ data: typeof rows }>('/orders').then((r) => setRows(r.data)) }, [])
  return (
    <>
      <h1>訂單</h1>
      <table>
        <thead><tr><th>訂單編號</th><th>狀態</th><th>金額</th><th>時間</th></tr></thead>
        <tbody>{rows.map((o) => (
          <tr key={o.order_no}><td><Link to={`/me/orders/${o.order_no}`}>{o.order_no}</Link></td><td>{o.status}</td><td className="price">{money(o.total)}</td><td>{new Date(o.created_at).toLocaleString('zh-TW')}</td></tr>
        ))}</tbody>
      </table>
    </>
  )
}

function MemberOrder() {
  const { orderNo } = useParams()
  const [o, setO] = useState<OrderDetail | null>(null)
  useEffect(() => { api<OrderDetail>(`/orders/${orderNo}`).then(setO) }, [orderNo])
  if (!o) return <p>載入中…</p>
  return <><h1>訂單 {o.order_no}　<small>{o.status}</small></h1><FulfillmentCards order={o} /></>
}

function Warehouse() {
  const [rows, setRows] = useState<Array<{ variant_id: number; name: string; balance: number }>>([])
  const [msg, setMsg] = useState('')
  const load = () => api<{ data: typeof rows }>('/warehouse').then((r) => setRows(r.data))
  useEffect(() => { load() }, [])

  async function withdraw(variantId: number) {
    try {
      await api('/warehouse/withdrawals', { method: 'POST', idempotencyKey: crypto.randomUUID(), body: JSON.stringify({ variant_id: variantId, qty: 1 }) })
      setMsg('已申請提領 1 包，物流處理中'); load()
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '提領失敗')
    }
  }

  return (
    <>
      <h1>寄倉</h1>
      {msg && <p className="toast">{msg}</p>}
      {rows.length === 0 ? <p>沒有寄倉商品</p> : (
        <table><tbody>{rows.map((w) => (
          <tr key={w.variant_id}><td>{w.name}</td><td>餘額 {w.balance}</td><td><button onClick={() => withdraw(w.variant_id)} disabled={w.balance < 1}>提領 1 包</button></td></tr>
        ))}</tbody></table>
      )}
    </>
  )
}
