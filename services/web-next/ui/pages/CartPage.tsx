'use client'

import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@/ui/router.tsx'
import { api, ApiError, currentUtm, money, track } from '../api.ts'
import { useMe } from '@/ui/shell.tsx'
import { field } from '../shelves.ts'

type Cart = { items: Array<{ id: number; name: string; brand: string; unit_price: number; qty: number; fulfillment_type: string; appointment_at: string | null; hold_expires_at: string | null }>; subtotal: number }

/** 醫院保留時段的倒數（§6.4.1）：到期前要結帳，否則要重選 */
function HoldCountdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const left = Math.max(0, Math.floor((Date.parse(until) - now) / 1000))
  return left === 0
    ? <small className="error">　保留已過期，請移除後重新選擇時段</small>
    : <small>　時段保留中，剩 {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</small>
}

export function CartPage() {
  const { me } = useMe()
  const navigate = useNavigate()
  const [cart, setCart] = useState<Cart | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // 冪等鍵：進到購物車頁產生一次；連按兩下「結帳」或網路重送，都用同一個 key → 只會有一張訂單
  const idempotencyKey = useRef(crypto.randomUUID())

  useEffect(() => { if (me) api<Cart>('/cart').then(setCart) }, [me])
  if (!me) return <div className="sheet"><p>請先 <Link to="/login">登入</Link></p></div>
  if (!cart) return <div className="sheet"><p>載入中…</p></div>

  async function remove(id: number) {
    setCart(await api<Cart>(`/cart/items/${id}`, { method: 'DELETE' }))
  }

  async function checkout() {
    setBusy(true); setError('')
    track('begin_checkout', { value: cart!.subtotal })
    try {
      const order = await api<{ order_no: string }>('/checkout', {
        method: 'POST', idempotencyKey: idempotencyKey.current, body: JSON.stringify(currentUtm()),
      })
      navigate(`/orders/${order.order_no}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '結帳失敗')
      idempotencyKey.current = crypto.randomUUID() // 失敗（例如庫存不足）改了購物車再結帳 → 換新的 key
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet">
      <h1>購物車</h1>
      {cart.items.length === 0 ? (
        <div className="empty"><p>購物車是空的。</p><Link className="button primary" to="/">去逛逛</Link></div>
      ) : (
        <>
          <table>
            <thead><tr><th>品牌</th><th>商品</th><th>交付</th><th>數量</th><th>小計</th><th></th></tr></thead>
            <tbody>
              {cart.items.map((i) => (
                <tr key={i.id}>
                  <td><span className="brand" style={field(i.brand)}>{i.brand}</span></td>
                  <td>{i.name}{i.appointment_at && <small>　預約 {new Date(i.appointment_at).toLocaleString('zh-TW')}</small>}
                    {i.hold_expires_at && <HoldCountdown until={i.hold_expires_at} />}</td>
                  <td>{i.fulfillment_type}</td>
                  <td>{i.qty}</td>
                  <td className="price">{money(i.unit_price * i.qty)}</td>
                  <td><button className="link" onClick={() => remove(i.id)}>移除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cart-foot">
            <p><span className="total">小計 {money(cart.subtotal)}</span><br /><small>運費依包裹計算，結帳時顯示</small></p>
            <button className="primary" onClick={checkout} disabled={busy}>{busy ? '處理中…' : '結帳'}</button>
          </div>
          {cart.items.some((i) => i.fulfillment_type === 'booking') && (
            <p className="muted">預約服務：付款時只先「授權」圈住額度，醫院確認預約後才請款；預約失敗會取消授權，不會被扣款。</p>
          )}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </div>
  )
}
