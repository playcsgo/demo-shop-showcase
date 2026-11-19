/** 假商店（test/fake-shop.ts）用的退款規則；正式的規則在 core-api 的 RefundPolicy（AIC-016）。期限和 sop/refund.md 的 §S2 一致，由 sop.spec.ts 檢查 */
export const REFUND_WINDOW_DAYS = 7;

export interface RefundOrder {
  payment_status: string;
  total: number;
  shipping_fee: number;
  refunded_amount: number;
  items: {
    id: number;
    qty: number;
    unit_price: number;
    refunded_qty: number;
  }[];
  delivered_at: (Date | null)[]; // 每個包裹一個；null＝還沒送到
}

export type RefundCode =
  | 'invalid_lines'
  | 'not_paid'
  | 'refund_exceeds_qty'
  | 'refund_exceeds_payment'
  | 'refund_window_expired';
export type RefundCheck =
  | { eligible: true; amount: number }
  | { eligible: false; code: RefundCode; amount?: number };

const DAY_MS = 86_400_000;

/**
 * 退款資格。確定性的規則，不經過模型：AI 的判斷錯了，這裡會擋下來（AC-13）。
 * 金額一律依明細算，運費不退
 */
export function checkRefund(
  order: RefundOrder,
  lines: Record<number, number>,
  now: Date,
): RefundCheck {
  const entries = Object.entries(lines).map(
    ([id, qty]) => [Number(id), qty] as const,
  );
  const byId = new Map(order.items.map((i) => [i.id, i]));
  if (
    !entries.length ||
    entries.some(
      ([id, qty]) => !byId.has(id) || !Number.isInteger(qty) || qty <= 0,
    )
  ) {
    return { eligible: false, code: 'invalid_lines' };
  }
  const amount = entries.reduce(
    (sum, [id, qty]) => sum + byId.get(id)!.unit_price * qty,
    0,
  );
  if (order.payment_status !== 'paid')
    return { eligible: false, code: 'not_paid', amount };
  if (
    entries.some(
      ([id, qty]) => qty > byId.get(id)!.qty - byId.get(id)!.refunded_qty,
    )
  ) {
    return { eligible: false, code: 'refund_exceeds_qty', amount };
  }
  if (amount > order.total - order.shipping_fee - order.refunded_amount)
    return { eligible: false, code: 'refund_exceeds_payment', amount };
  // 期限從最後一個包裹送達算；還有包裹沒送到就不受限制
  const delivered = order.delivered_at;
  if (delivered.length && delivered.every((d) => d !== null)) {
    const last = Math.max(...delivered.map((d) => d!.getTime()));
    if (now.getTime() - last > REFUND_WINDOW_DAYS * DAY_MS)
      return { eligible: false, code: 'refund_window_expired', amount };
  }
  return { eligible: true, amount };
}
