import { Link } from 'react-router-dom'
import { type BatchWarning, formatMoney, type MoqResult, orderStatusLabel, type PricedOrder, warningTexts } from './types.ts'

/** 預覽和批次詳情共用：每張單的金額、MOQ、國家禁令警告 */
export function BatchSummary({ orders, orderType = '', currency, total, prepay, prepayBps, moq, warnings }: {
  orderType?: string; orders: Array<PricedOrder & { status?: string; order_no?: string; eta_date?: string | null }>; currency: string; total: number; prepay: number; prepayBps: number
  moq: MoqResult[]; warnings: BatchWarning[]
}) {
  return (
    <>
      <div className="cards">
        {orders.map((o) => (
          <div className="card" key={o.shop_id}>
            <h3>{o.shop_name}{o.requested_ship_date && <span className="muted">（交期 {o.requested_ship_date}）</span>}</h3>
            {o.order_no && <p><Link to={`/orders/${o.order_no}`}>{o.order_no}</Link> <span className="badge">{orderStatusLabel(o.status ?? '', orderType)}</span>{o.eta_date && <span className="muted"> 預計抵達 {o.eta_date}</span>}</p>}
            <table>
              <tbody>
                {o.items.map((i) => (
                  <tr key={i.product_id}>
                    <td>{i.sku}{i.hs_code && <div className="muted">HS code {i.hs_code}（參考，以貨代為準）</div>}</td>
                    <td>{i.qty_cases} 箱（{i.qty_units} 件）</td>
                    <td>{formatMoney(i.unit_price_minor, currency)} / 箱</td>
                    <td>{formatMoney(i.amount_minor, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="total">小計 {formatMoney(o.subtotal_minor, currency)}</p>
          </div>
        ))}
      </div>
      <p className="total">合計 {formatMoney(total, currency)}</p>
      {prepayBps > 0 && <p>預付 {prepayBps / 100}%：{formatMoney(prepay, currency)}</p>}
      {moq.filter((m) => !m.met).map((m) => <p className="error" key={m.sku}>{m.sku} 合計 {m.total_cases} 箱，未達 MOQ {m.moq_cases} 箱（可以送出，由業務審核）</p>)}
      {warnings.length > 0 && <h3>提醒</h3>}
      {warnings.map((w) => <p key={`${w.shop_name}-${w.sku}`} className={w.banned ? 'error' : 'muted'}>{w.shop_name}．{w.sku}：{warningTexts(w).join('、')}</p>)}
    </>
  )
}
