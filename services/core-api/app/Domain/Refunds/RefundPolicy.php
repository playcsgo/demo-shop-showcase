<?php

namespace App\Domain\Refunds;

use App\Models\Order;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * 退款資格（AIC-016）：確定性的規則，不經過模型。AI 客服判斷錯了，核准時這裡會擋下來。
 * 規則和 support 的退款 SOP 一致：每個品項看自己出貨單送達的時間，超過 7 天不能退；
 * 還沒送達的不受期限限制。金額依明細算，運費不退。
 *
 * 只讀不寫：預覽直接用；RefundService::request 也先跑一次，真正佔住數量和金額的還是它的條件式 UPDATE（防併發）。
 *
 * @phpstan-type Verdict array{eligible: bool, code: ?string, amount: int}
 */
class RefundPolicy
{
    public const WINDOW_DAYS = 7;

    /**
     * @param  array<int,int>  $lines  [order_item_id => qty]
     * @return Verdict
     */
    public function evaluate(Order $order, array $lines, ?Carbon $now = null, bool $ignoreWindow = false): array
    {
        $items = $order->items()->get()->keyBy('id');
        $no = fn (string $code, int $amount = 0) => ['eligible' => false, 'code' => $code, 'amount' => $amount];

        if ($lines === []) {
            return $no('invalid_lines');
        }
        foreach ($lines as $id => $qty) {
            if (! isset($items[$id]) || ! is_int($qty) || $qty <= 0) {
                return $no('invalid_lines');
            }
        }
        $amount = array_sum(array_map(fn ($id, $qty) => $items[$id]->unit_price * $qty, array_keys($lines), $lines));

        $payment = $order->payment()->first();
        if ($payment?->status !== 'SUCCEEDED') {
            return $no('not_paid', $amount);
        }
        foreach ($lines as $id => $qty) {
            if ($qty > $items[$id]->refundableQty()) {
                return $no('refund_exceeds_qty', $amount);
            }
        }
        if ($payment->refunded_amount + $amount > $payment->amount) {
            return $no('refund_exceeds_payment', $amount);
        }
        if (! $ignoreWindow) {
            $deadline = ($now ?? now())->copy()->subDays(self::WINDOW_DAYS);
            foreach ($this->deliveredAt(array_keys($lines)) as $at) {
                if ($at !== null && Carbon::parse($at)->lt($deadline)) {
                    return $no('refund_window_expired', $amount);
                }
            }
        }

        return ['eligible' => true, 'code' => null, 'amount' => $amount];
    }

    /**
     * 每個品項所在出貨單的送達時間（DELIVERED 事件）；還沒送達、沒有出貨單（寄倉、預約）就沒有
     *
     * @param  list<int>  $itemIds
     * @return list<?string>
     */
    private function deliveredAt(array $itemIds): array
    {
        return DB::table('shipment_items as si')
            ->join('shipment_events as e', fn ($j) => $j->on('e.shipment_id', '=', 'si.shipment_id')->where('e.status', 'DELIVERED'))
            ->whereIn('si.order_item_id', $itemIds)
            ->pluck('e.occurred_at')->all();
    }
}
