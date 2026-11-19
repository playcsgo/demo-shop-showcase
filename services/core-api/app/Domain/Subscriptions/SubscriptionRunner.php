<?php

namespace App\Domain\Subscriptions;

use App\Domain\Checkout\CheckoutService;
use App\Domain\DomainException;
use App\Enums\FulfillmentType;
use App\Models\Subscription;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * 訂閱續期（§5.7）：每秒掃一次到期的訂閱，每一期產生一張新訂單並自動扣款。
 *  - SELECT … FOR UPDATE SKIP LOCKED：開多個 worker 也不會搶同一筆
 *  - (subscription_id, cycle_no) 唯一：就算排程重複執行，同一期也只有一張訂單（第二道防線）
 */
class SubscriptionRunner
{
    public function __construct(private CheckoutService $checkout) {}

    /** @return int 這次產生的訂單數 */
    public function runDue(int $limit = 50): int
    {
        $created = 0;

        $dueIds = DB::transaction(fn () => DB::table('subscriptions')
            ->where('status', 'ACTIVE')->where('next_run_at', '<=', now())
            ->orderBy('next_run_at')->limit($limit)
            ->lock('for update skip locked')->pluck('id'));

        foreach ($dueIds as $id) {
            try {
                $created += $this->renew($id) ? 1 : 0;
            } catch (DomainException $e) {
                Log::warning('subscription renewal failed', ['subscription_id' => $id, 'reason' => $e->reason]);
                $this->recordFailure($id);
            }
        }

        return $created;
    }

    private function renew(int $subscriptionId): bool
    {
        return DB::transaction(function () use ($subscriptionId) {
            $sub = Subscription::with('customer', 'variant')->lockForUpdate()->find($subscriptionId);
            if ($sub->status !== 'ACTIVE' || $sub->next_run_at->isFuture()) {
                return false; // 別的 worker 剛處理過
            }

            try {
                $cycle = $sub->cycles()->create(['cycle_no' => $sub->next_cycle_no, 'status' => 'PENDING', 'attempts' => 1]);
            } catch (UniqueConstraintViolationException) {
                return false; // 這一期已經產生過
            }

            $order = $this->checkout->placeOrder($sub->customer, [[
                'variant' => $sub->variant, 'qty' => $sub->qty,
                'fulfillment_type' => FulfillmentType::Subscription, 'appointment_at' => null,
            ]], ['utm_source' => 'subscription'], (string) Str::uuid(), $sub->id);

            $cycle->update(['order_id' => $order->id]);

            $isLast = $sub->next_cycle_no >= $sub->total_cycles;
            $sub->update([
                'next_cycle_no' => $sub->next_cycle_no + 1,
                'next_run_at' => now()->addSeconds($sub->interval_seconds),
                'status' => $isLast ? 'COMPLETED' : 'ACTIVE',
            ]);

            return true;
        });
    }

    /** 付款結果回來時更新這一期；連續失敗 3 次暫停訂閱 */
    public function onPaymentResult(int $orderId, bool $succeeded): void
    {
        $cycle = DB::table('subscription_cycles')->where('order_id', $orderId)->first();
        if (! $cycle) {
            return;
        }

        DB::table('subscription_cycles')->where('id', $cycle->id)->where('status', 'PENDING')
            ->update(['status' => $succeeded ? 'PAID' : 'FAILED', 'updated_at' => now()]);

        if ($succeeded) {
            DB::table('subscriptions')->where('id', $cycle->subscription_id)->update(['consecutive_failures' => 0]);
        } else {
            $this->recordFailure($cycle->subscription_id);
        }
    }

    private function recordFailure(int $subscriptionId): void
    {
        DB::table('subscriptions')->where('id', $subscriptionId)->increment('consecutive_failures');
        DB::table('subscriptions')->where('id', $subscriptionId)->where('status', 'ACTIVE')
            ->where('consecutive_failures', '>=', config('shop.subscription.max_consecutive_failures'))
            ->update(['status' => 'PAUSED', 'updated_at' => now()]);
    }
}
