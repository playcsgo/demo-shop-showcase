import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.ts'
import { formatMoney, orderStatusLabel } from './types.ts'

type Order = {
  order_no: string; status: string; order_type: string; eta_date: string | null; batch_no: string; shop_name: string; requested_ship_date: string | null
  subtotal_minor: number; currency: string; timeline: Array<{ type: string; label: string; occurred_at: string; note: string | null }>
}

export function OrderTimelinePage() {
  const { orderNo } = useParams()
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { api<Order>(`/orders/${orderNo}`).then(setOrder).catch((e) => setError(e.message)) }, [orderNo])

  if (error) return <p className="error">{error}</p>
  if (!order) return <p className="muted">載入中…</p>

  return (
    <>
      <p><Link to={`/batches/${order.batch_no}`}>← 回到批次 {order.batch_no}</Link></p>
      <h1>{order.order_no}</h1>
      <p><span className="badge">{orderStatusLabel(order.status, order.order_type)}</span> {order.shop_name}．{formatMoney(order.subtotal_minor, order.currency)}
        {order.requested_ship_date && `．交期 ${order.requested_ship_date}`}{order.eta_date && `．預計抵達 ${order.eta_date}`}</p>
      <h2>進度</h2>
      <div className="cards">
        {order.timeline.map((t, i) => (
          <div className="fcard" key={`${t.type}-${i}`}>
            <div className="fhead"><strong>{t.label}</strong><span className="muted">{new Date(t.occurred_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</span></div>
            {t.note && <div className="error">{t.note}</div>}
          </div>
        ))}
      </div>
    </>
  )
}
