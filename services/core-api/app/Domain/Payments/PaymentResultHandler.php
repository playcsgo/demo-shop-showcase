<?php

namespace App\Domain\Payments;

use App\Domain\Booking\BookingResultHandler;
use App\Domain\Catalog\InventoryService;
use App\Domain\Fulfillment\FulfillmentDispatcher;
use App\Domain\Messaging\Outbox;
use App\Domain\Observability\OrderStageMetrics;
use App\Domain\Ordering\OrderTransitions;
use App\Domain\Settlement\SettlementRecorder;
use App\Domain\Subscriptions\SubscriptionRunner;
use App\Enums\OrderStatus;
use App\Models\Order;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Saga 第 5 步（§6.3）：處理付款結果。
 * 由 inbox 呼叫（M5），重複的通知會被 inbox 擋掉；就算漏網，狀態轉移也是條件式的 → 只會處理一次。
 */
class PaymentResultHandler
{
    public function __construct(
        private OrderTransitions $transitions,
        private InventoryService $inventory,
        private SettlementRecorder $settlement,
        private FulfillmentDispatcher $fulfillment,
        private SubscriptionRunner $subscriptions,
        private Outbox $outbox,
        private BookingResultHandler $bookings,
        private OrderStageMetrics $stages,
    ) {}

    /**
     * hub 已經把扣款送給金流、金流也收下了（webhook 還沒來）：PENDING → SUBMITTED。
     * 從這時才開始計時對帳：還在佇列裡排隊（PENDING）的不問，問了金流也是查無此筆，只會讓積壓更嚴重
     */
    public function submitted(string $orderNo, string $providerTxnId): bool
    {
        $orderId = Order::where('order_no', $orderNo)->value('id');
        $ok = DB::table('payments')->where('order_id', $orderId)->where('status', 'PENDING')->update([
            'status' => 'SUBMITTED', 'provider_txn_id' => $providerTxnId, 'submitted_at' => now(), 'reconcile_attempts' => 0,
            'next_reconcile_at' => now()->addSeconds((int) config('shop.payment_reconcile_after_seconds')), 'updated_at' => now(),
        ]) === 1;
        Log::debug($ok ? 'payment submitted to provider (start reconcile clock)' : 'payment.submitted ignored (not PENDING)', ['order_no' => $orderNo]);
        if ($ok) {
            $this->stages->record($orderId, 'payment_submitted');   // 下單到 hub 把付款交給金流：主要是佇列等待的時間
        }

        return $ok;
    }

    public function succeeded(string $orderNo, string $providerTxnId, int $amount): bool
    {
        return DB::transaction(function () use ($orderNo, $providerTxnId, $amount) {
            $order = Order::where('order_no', $orderNo)->firstOrFail();

            if ($amount !== $order->total) {
                throw new \UnexpectedValueException("金額不符：訂單 {$order->total}、金流 {$amount}"); // 不自動處理，進 DLQ 由人看
            }
            if (! $this->transitions->transition($order->id, OrderStatus::Paid, ['paid_at' => now()])) {
                // 訂單已經失敗或取消，付款成功卻晚到了 → 客人被扣了錢但沒有訂單 → 自動全額退款
                if (in_array($order->status, [OrderStatus::PaymentFailed, OrderStatus::Cancelled], true)) {
                    $this->refundLatePayment($order, $providerTxnId);
                }

                return false; // 其他情況：已處理過 → 冪等略過
            }

            DB::table('payments')->where('order_id', $order->id)->whereIn('status', ['PENDING', 'SUBMITTED', 'AUTHORIZED'])->update([
                'status' => 'SUCCEEDED', 'provider_txn_id' => $providerTxnId, 'succeeded_at' => now(), 'updated_at' => now(),
            ]);
            $this->inventory->commit($order->id);
            Log::info('payment succeeded → order PAID', ['order_no' => $orderNo, 'amount' => $amount, 'provider_txn_id' => $providerTxnId]);

            $order->refresh();
            $this->settlement->recordSale($order);
            $this->fulfillment->dispatch($order);
            $this->subscriptions->onPaymentResult($order->id, true);

            return true;
        });
    }

    /**
     * 預約（TCC）：額度已圈住 → 請醫院確認。醫院確認後才請款（BookingResultHandler）。
     * 訂單已經失敗／取消才收到授權（晚到）→ 直接取消授權，客人帳單上不會有這筆。
     */
    public function authorized(string $orderNo, string $providerTxnId, int $amount): bool
    {
        return DB::transaction(function () use ($orderNo, $providerTxnId, $amount) {
            $order = Order::where('order_no', $orderNo)->lockForUpdate()->firstOrFail();
            if ($amount !== $order->total) {
                throw new \UnexpectedValueException("金額不符：訂單 {$order->total}、金流 {$amount}");
            }

            if ($order->status !== OrderStatus::PendingPayment) {
                if (in_array($order->status, [OrderStatus::PaymentFailed, OrderStatus::Cancelled], true)) {
                    $this->voidLateAuthorization($order, $providerTxnId);
                }

                return false;
            }

            // 授權後重新計時：卡住超過 stuck_after 才重送下一步（PaymentReconciler::redriveAuthorizations，指數退避）
            $changed = DB::table('payments')->where('order_id', $order->id)->whereIn('status', ['PENDING', 'SUBMITTED'])->update([
                'status' => 'AUTHORIZED', 'provider_txn_id' => $providerTxnId, 'authorized_at' => now(), 'updated_at' => now(),
                'reconcile_attempts' => 0, 'next_reconcile_at' => now()->addSeconds((int) config('shop.booking.stuck_after_seconds')),
            ]);
            if ($changed === 0) {
                return false; // 重複的授權通知
            }
            Log::info('payment authorized → ask clinic to confirm', ['order_no' => $orderNo, 'amount' => $amount]);

            foreach (DB::table('bookings')->where('order_no', $orderNo)->where('status', 'HELD')->get() as $booking) {
                DB::table('bookings')->where('id', $booking->id)->update(['status' => 'AUTHORIZED', 'updated_at' => now()]);
                $this->outbox->record('booking.confirm.requested', 'core-commands', [
                    'booking_id' => $booking->id, 'hold_id' => $booking->hold_id, 'order_no' => $orderNo,
                    'appointment_at' => Carbon::parse($booking->appointment_at)->timezone('Asia/Taipei')->toIso8601String(),
                ], $order->correlation_id);
            }

            return true;
        });
    }

    /** 取消授權完成 */
    public function voided(string $orderNo): bool
    {
        $orderId = Order::where('order_no', $orderNo)->value('id');

        $ok = DB::table('payments')->where('order_id', $orderId)->where('status', 'AUTHORIZED')
            ->update(['status' => 'VOIDED', 'updated_at' => now()]) === 1;
        Log::info($ok ? 'authorization voided (customer not charged)' : 'void result ignored (not AUTHORIZED)', ['order_no' => $orderNo]);

        return $ok;
    }

    private function voidLateAuthorization(Order $order, string $providerTxnId): void
    {
        $changed = DB::table('payments')->where('order_id', $order->id)->whereIn('status', ['PENDING', 'SUBMITTED', 'FAILED'])->update([
            'status' => 'AUTHORIZED', 'provider_txn_id' => $providerTxnId, 'authorized_at' => now(), 'updated_at' => now(),
        ]);
        if ($changed === 0) {
            return;
        }
        $this->outbox->record('payment.void.requested', 'core-commands', ['order_no' => $order->order_no, 'provider_txn_id' => $providerTxnId], $order->correlation_id);
        Log::warning('late authorization after failure, auto void', ['order_no' => $order->order_no]);
    }

    /** 補償：晚到的付款成功（訂單已失敗／取消）→ 記下這筆付款，並送出全額退款 */
    private function refundLatePayment(Order $order, string $providerTxnId): void
    {
        $changed = DB::table('payments')->where('order_id', $order->id)->where('status', '!=', 'SUCCEEDED')->update([
            'status' => 'SUCCEEDED', 'provider_txn_id' => $providerTxnId, 'succeeded_at' => now(),
            'refunded_amount' => DB::raw('amount'), 'updated_at' => now(),
        ]);
        if ($changed === 0) {
            return; // 已補償過
        }

        $payment = $order->payment()->first();
        $refund = $order->refunds()->create([
            'payment_id' => $payment->id, 'amount' => $payment->amount, 'reason' => 'late_payment_after_failure',
            'status' => 'PENDING', 'idempotency_key' => "late-payment:{$order->order_no}",
        ]);
        app(Outbox::class)->record('refund.requested', 'core-commands', [
            'refund_id' => $refund->id, 'order_no' => $order->order_no, 'provider_txn_id' => $providerTxnId,
            'amount' => $payment->amount, 'idempotency_key' => $refund->idempotency_key,
        ], $order->correlation_id);

        Log::warning('late payment after failure, auto refund', ['order_no' => $order->order_no, 'amount' => $payment->amount]);
    }

    public function failed(string $orderNo, string $reason): bool
    {
        return DB::transaction(function () use ($orderNo, $reason) {
            $order = Order::where('order_no', $orderNo)->firstOrFail();

            if (! $this->transitions->transition($order->id, OrderStatus::PaymentFailed)) {
                return false;
            }

            DB::table('payments')->where('order_id', $order->id)->whereIn('status', ['PENDING', 'SUBMITTED'])->update(['status' => 'FAILED', 'updated_at' => now()]);
            $this->inventory->release($order->id); // 補償：釋放預留
            Log::info('payment failed → release reservations and holds', ['order_no' => $orderNo, 'reason' => $reason]);
            $this->bookings->cancelOpen($order, 'payment_failed'); // 預約：釋放醫院的時段
            $this->subscriptions->onPaymentResult($order->id, false);

            return true;
        });
    }
}
