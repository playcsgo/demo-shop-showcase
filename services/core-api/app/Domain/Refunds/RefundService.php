<?php

namespace App\Domain\Refunds;

use App\Domain\DomainException;
use App\Domain\Messaging\Outbox;
use App\Models\Order;
use App\Models\Refund;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * 部分退款（§5.5）：以「訂單明細」為單位。
 * 申請時就用條件式 UPDATE 佔住可退數量與金額 → 兩個人同時退同一項，只有一個會成功。
 * 真正退錢由 hub 呼叫金流（outbox: refund.requested），成功後的處理在 RefundCompletion。
 */
class RefundService
{
    private const MESSAGES = [
        'invalid_lines' => '退款明細不合法',
        'not_paid' => '訂單尚未付款',
        'refund_exceeds_qty' => '可退數量不足',
        'refund_exceeds_payment' => '退款金額超過付款金額',
        'refund_window_expired' => '已超過送達後 '.RefundPolicy::WINDOW_DAYS.' 天的退款期限',
    ];

    public function __construct(private Outbox $outbox, private RefundPolicy $policy) {}

    /**
     * @param  array<int,int>  $lines  [order_item_id => qty]
     * @param  ?string  $requestedBy  誰發起的：support_staff:3、admin:1、load_test（AIC-016）
     * @param  ?string  $overrideReason  超過退款期限仍要退的原因；有填才略過期限（後台例外、壓測）
     */
    public function request(Order $order, array $lines, string $reason, string $idempotencyKey, ?string $requestedBy = null, ?string $overrideReason = null): Refund
    {
        if ($existing = Refund::where('idempotency_key', $idempotencyKey)->first()) {
            return $existing;
        }
        // 先過退款政策（AIC-016）：期限、數量、金額。這裡沒有加鎖，防併發的還是下面的條件式 UPDATE
        $verdict = $this->policy->evaluate($order, $lines, ignoreWindow: $overrideReason !== null);
        if (! $verdict['eligible']) {
            throw new DomainException($verdict['code'], self::MESSAGES[$verdict['code']] ?? '不能退款', 409);
        }

        try {
            return DB::transaction(function () use ($order, $lines, $reason, $idempotencyKey, $requestedBy, $overrideReason) {
                $items = $order->items()->whereIn('id', array_keys($lines))->get()->keyBy('id');
                $total = 0;

                foreach ($lines as $itemId => $qty) {
                    $item = $items[$itemId] ?? throw new DomainException('item_not_in_order', "明細 {$itemId} 不屬於這張訂單");

                    $affected = DB::update(
                        'UPDATE order_items SET refunded_qty = refunded_qty + ?, updated_at = NOW()
                          WHERE id = ? AND refunded_qty + ? <= qty',
                        [$qty, $itemId, $qty],
                    );
                    if ($affected === 0) {
                        throw new DomainException('refund_exceeds_qty', "明細 {$itemId} 可退數量不足", 409);
                    }
                    $total += $item->unit_price * $qty;
                }

                $payment = $order->payment ?? throw new DomainException('not_paid', '訂單尚未付款');
                $affected = DB::update(
                    "UPDATE payments SET refunded_amount = refunded_amount + ?, updated_at = NOW()
                      WHERE id = ? AND status = 'SUCCEEDED' AND refunded_amount + ? <= amount",
                    [$total, $payment->id, $total],
                );
                if ($affected === 0) {
                    throw new DomainException('refund_exceeds_payment', '退款金額超過付款金額', 409);
                }

                $refund = Refund::create([
                    'payment_id' => $payment->id, 'order_id' => $order->id, 'amount' => $total,
                    'reason' => $reason, 'status' => 'PENDING', 'idempotency_key' => $idempotencyKey,
                    'requested_by' => $requestedBy, 'override_reason' => $overrideReason,
                ]);
                foreach ($lines as $itemId => $qty) {
                    $refund->items()->create(['order_item_id' => $itemId, 'qty' => $qty, 'amount' => $items[$itemId]->unit_price * $qty]);
                }

                $this->outbox->record('refund.requested', 'core-commands', [
                    'refund_id' => $refund->id,
                    'order_no' => $order->order_no,
                    'provider_txn_id' => $payment->provider_txn_id,
                    'amount' => $total,
                    'idempotency_key' => $idempotencyKey,
                ], $order->correlation_id);

                return $refund;
            });
        } catch (UniqueConstraintViolationException) {
            return Refund::where('idempotency_key', $idempotencyKey)->firstOrFail();
        }
    }
}
