'use client'

import { money } from '../api.ts'

export type OrderDetail = {
  order_no: string; status: string; subtotal: number; shipping_fee: number; total: number
  progress: { done: number; total: number }
  items: Array<{ id: number; name: string; qty: number; unit_price: number; brand: string; fulfillment_type: string; fulfillment_status: string; refunded_qty: number }>
  fulfillments: Array<{ type: 'shipment' | 'warehouse' | 'booking'; title: string; status: string; done: boolean; carrier?: string; tracking_no?: string | null
    items?: Array<{ name: string; qty: number }>; events?: Array<{ status: string; at: string }>; appointment_at?: string; order_no?: string; cancel_reason?: string | null }>
}

const STATUS: Record<string, string> = {
  REQUESTED: '處理中', PICKED_UP: '已收件', IN_TRANSIT: '配送中', DELIVERED: '已送達', CONFIRMED: '預約成功', FAILED: '失敗',
  HELD: '時段保留中', AUTHORIZED: '醫院確認中', CANCELLED: '已取消（未扣款）',
  DONE: '已入帳', PROCESSING: '處理中', PENDING: '處理中', REFUNDED: '已退款',
}
const CANCEL_REASON: Record<string, string> = {
  hold_expired: '付款完成時，醫院的時段保留已過期', clinic_unavailable: '醫院系統暫時無法確認', payment_failed: '付款失敗', slot_full: '時段已額滿',
}

/** 交付卡片清單（§6.5）：包裹有物流軌跡；寄倉顯示入帳；服務只有種類、時段、訂單編號 */
export function FulfillmentCards({ order }: { order: OrderDetail }) {
  return (
    <div className="cards">
      <p className="progress">進度 {order.progress.done}／{order.progress.total}</p>
      {order.fulfillments.map((f, i) => (
        <div key={i} className={`fcard ${f.done ? 'done' : ''}`}>
          <div className="fhead">
            <span>{f.title}{f.carrier && <small>（{f.carrier === 'bulky_freight' ? '大型物流' : '宅配'}）</small>}</span>
            <span className="badge">{STATUS[f.status] ?? f.status}</span>
          </div>
          {f.items && <div>{f.items.map((x) => `${x.name} ×${x.qty}`).join('、')}</div>}
          {f.type === 'booking' && <div>預約 {new Date(f.appointment_at!).toLocaleString('zh-TW')}　訂單 {f.order_no}</div>}
          {f.type === 'booking' && f.status === 'CANCELLED' && <div className="muted">{CANCEL_REASON[f.cancel_reason ?? ''] ?? '預約未成立'}，信用卡授權已取消</div>}
          {f.tracking_no && <div className="muted">追蹤碼 {f.tracking_no}</div>}
          {f.events && f.events.length > 0 && <div className="timeline">{f.events.map((e) => STATUS[e.status] ?? e.status).join(' → ')}</div>}
        </div>
      ))}
      <p className="total">小計 {money(order.subtotal)}＋運費 {money(order.shipping_fee)}＝{money(order.total)}</p>
    </div>
  )
}
