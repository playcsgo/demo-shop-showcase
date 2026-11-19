import { checkRefund, type RefundOrder } from './refund-policy.js';

const now = new Date('2026-11-11T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const order = (over: Partial<RefundOrder> = {}): RefundOrder => ({
  payment_status: 'paid',
  total: 878,
  shipping_fee: 0,
  refunded_amount: 0,
  items: [
    { id: 1, qty: 6, unit_price: 48, refunded_qty: 0 },
    { id: 2, qty: 1, unit_price: 590, refunded_qty: 0 },
  ],
  delivered_at: [daysAgo(3)],
  ...over,
});

describe('退款資格', () => {
  it('7 天內通過；金額由明細算出', () => {
    expect(checkRefund(order(), { 1: 2 }, now)).toEqual({
      eligible: true,
      amount: 96,
    });
  });

  it('剛好 7 天還可以；超過就拒絕', () => {
    expect(
      checkRefund(order({ delivered_at: [daysAgo(7)] }), { 1: 1 }, now)
        .eligible,
    ).toBe(true);
    expect(
      checkRefund(
        order({ delivered_at: [new Date(daysAgo(7).getTime() - 1000)] }),
        { 1: 1 },
        now,
      ),
    ).toEqual({ eligible: false, code: 'refund_window_expired', amount: 48 });
  });

  it('期限從最後一個包裹送達算；還有包裹沒送到就不受限制', () => {
    expect(
      checkRefund(
        order({ delivered_at: [daysAgo(30), daysAgo(2)] }),
        { 1: 1 },
        now,
      ).eligible,
    ).toBe(true);
    expect(
      checkRefund(order({ delivered_at: [daysAgo(30), null] }), { 1: 1 }, now)
        .eligible,
    ).toBe(true);
  });

  it('沒付款不能退', () => {
    expect(
      checkRefund(order({ payment_status: 'unpaid' }), { 1: 1 }, now),
    ).toMatchObject({ code: 'not_paid' });
  });

  it('超過可退數量（含已經退過的）', () => {
    expect(checkRefund(order(), { 1: 7 }, now)).toMatchObject({
      code: 'refund_exceeds_qty',
    });
    const partly = order({
      items: [{ id: 1, qty: 6, unit_price: 48, refunded_qty: 5 }],
    });
    expect(checkRefund(partly, { 1: 2 }, now)).toMatchObject({
      code: 'refund_exceeds_qty',
    });
  });

  it('超過可退金額（運費不退）', () => {
    expect(
      checkRefund(order({ refunded_amount: 850 }), { 1: 1 }, now),
    ).toMatchObject({ code: 'refund_exceeds_payment' });
  });

  it.each([{}, { 99: 1 }, { 1: 0 }, { 1: -1 }, { 1: 1.5 }])(
    '明細不合法（%j）',
    (lines) => {
      expect(
        checkRefund(order(), lines as Record<number, number>, now),
      ).toMatchObject({ code: 'invalid_lines' });
    },
  );
});
