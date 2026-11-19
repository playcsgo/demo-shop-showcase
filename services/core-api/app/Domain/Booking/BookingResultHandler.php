<?php

namespace App\Domain\Booking;

use App\Domain\Messaging\Outbox;
use App\Domain\Ordering\OrderTransitions;
use App\Enums\OrderStatus;
use App\Models\Order;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * 預約 TCC 的 Confirm／Cancel（§6.4.1、B14）：
 *   HELD（醫院保留）→ AUTHORIZED（額度圈住）→ 醫院確認 → CONFIRMED → 請款（payment.capture.requested）
 *   任何一步失敗 → CANCELLED：取消授權＋釋放時段。客人沒有被扣款，所以「沒有退款」
 * 每一步都是條件式更新（只從預期的狀態轉移）→ 重複或亂序的事件只會生效一次。
 */
class BookingResultHandler
{
    public function __construct(private OrderTransitions $transitions, private Outbox $outbox) {}

    public function confirmed(array $p): void
    {
        DB::transaction(function () use ($p) {
            $changed = DB::table('bookings')->where('id', $p['booking_id'])->where('status', 'AUTHORIZED')->update([
                'status' => 'CONFIRMED', 'provider_booking_id' => $p['provider_booking_id'], 'updated_at' => now(),
            ]);
            if ($changed === 0) {
                Log::debug('booking.confirmed ignored (not AUTHORIZED)', ['booking_id' => $p['booking_id']]);

                return;
            }

            // 醫院確認了才請款；請款成功（payment.succeeded）→ 訂單 PAID → 明細完成
            $order = Order::where('order_no', DB::table('bookings')->where('id', $p['booking_id'])->value('order_no'))->firstOrFail();
            $payment = $order->payment()->first();
            Log::info('booking confirmed by clinic → capture payment', ['booking_id' => $p['booking_id'], 'order_no' => $order->order_no, 'provider_booking_id' => $p['provider_booking_id']]);
            $this->outbox->record('payment.capture.requested', 'core-commands', [
                'order_no' => $order->order_no, 'provider_txn_id' => $payment->provider_txn_id, 'amount' => $payment->amount,
            ], $order->correlation_id);
        });
    }

    public function failed(array $p): void
    {
        DB::transaction(function () use ($p) {
            $booking = DB::table('bookings')->where('id', $p['booking_id'])->first();
            $order = Order::where('order_no', $booking->order_no)->firstOrFail();
            if (! $this->cancel($order, $booking, $p['reason'] ?? 'unknown')) {
                return;
            }

            Log::warning('booking failed → cancel order, void authorization, release hold', ['booking_id' => $booking->id, 'order_no' => $order->order_no, 'reason' => $p['reason'] ?? 'unknown']);
            $this->transitions->transition($order->id, OrderStatus::Cancelled);
            $payment = $order->payment()->first();
            if ($payment->status === 'AUTHORIZED') {
                $this->outbox->record('payment.void.requested', 'core-commands', [
                    'order_no' => $order->order_no, 'provider_txn_id' => $payment->provider_txn_id,
                ], $order->correlation_id);
            }
        });
    }

    /** 付款失敗等情況：還沒確認的預約全部取消、釋放時段（必須在交易內呼叫） */
    public function cancelOpen(Order $order, string $reason): void
    {
        foreach (DB::table('bookings')->where('order_no', $order->order_no)->whereIn('status', ['HELD', 'AUTHORIZED'])->get() as $booking) {
            $this->cancel($order, $booking, $reason);
        }
    }

    private function cancel(Order $order, object $booking, string $reason): bool
    {
        $changed = DB::table('bookings')->where('id', $booking->id)->whereIn('status', ['HELD', 'AUTHORIZED'])->update([
            'status' => 'CANCELLED', 'failure_reason' => $reason, 'updated_at' => now(),
        ]);
        if ($changed === 0) {
            return false;
        }

        DB::table('order_items')->where('id', $booking->order_item_id)->update(['fulfillment_status' => 'CANCELLED', 'updated_at' => now()]);
        // 已經確認的不會走到這裡；醫院那邊就算剛好確認了（回應遺失），釋放也會一併取消
        $this->outbox->record('booking.release.requested', 'core-commands', ['hold_id' => $booking->hold_id, 'reason' => $reason], $order->correlation_id);

        return true;
    }
}
