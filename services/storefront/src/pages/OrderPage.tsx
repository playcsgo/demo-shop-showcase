import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, track } from '../api.ts'
import { FulfillmentCards, type OrderDetail } from '../components/FulfillmentCards.tsx'
import { PHOTOS } from '../photos.ts'

const PETS = Object.values(PHOTOS)

/**
 * 結帳後的等待頁（§6.6）：付款結果要等金流 webhook → 非同步，所以輪詢訂單狀態，期間顯示一張隨機的貓狗照片慢慢呼吸。
 * 動畫改善的是「體感」，不是真正的速度。
 */
export function OrderPage() {
  const { orderNo } = useParams()
  const [order, setOrder] = useState<OrderDetail | null>(null)
  const [pet] = useState(() => PETS[Math.floor(Math.random() * PETS.length)])

  useEffect(() => {
    let stop = false
    let tracked = false
    async function poll() {
      while (!stop) {
        const o = await api<OrderDetail>(`/orders/${orderNo}`)
        setOrder(o)
        if (!['PENDING_PAYMENT', 'PAYMENT_FAILED', 'CANCELLED'].includes(o.status) && !tracked) { track('purchase', { order_no: o.order_no, value: o.total }); tracked = true }
        if (['COMPLETED', 'PAYMENT_FAILED', 'CANCELLED', 'REFUNDED'].includes(o.status)) break
        await new Promise((r) => setTimeout(r, o.status === 'PENDING_PAYMENT' ? 800 : 2000))
      }
    }
    poll()
    return () => { stop = true }
  }, [orderNo])

  if (!order || order.status === 'PENDING_PAYMENT') {
    return (
      <div className="sheet waiting" role="status" aria-live="polite">
        <div className="pet"><img src={pet.src} alt="" width={pet.w} height={pet.h} /></div>
        <p>付款確認中…</p>
        <p className="muted">訂單 {orderNo}</p>
      </div>
    )
  }

  return (
    <div className="sheet">
      <h1>訂單 {order.order_no}</h1>
      <p>狀態：<b>{order.status}</b></p>
      {order.status === 'PAYMENT_FAILED' ? <p className="error">付款失敗，庫存已釋放</p> : <FulfillmentCards order={order} />}
    </div>
  )
}
