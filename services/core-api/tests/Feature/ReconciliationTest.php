<?php

use App\Domain\Checkout\CheckoutService;
use App\Domain\Payments\PaymentResultHandler;
use App\Domain\Reconciliation\InvariantChecker;
use App\Domain\Reconciliation\PaymentReconciler;
use App\Domain\Settlement\SettlementRecorder;
use App\Domain\Subscriptions\SubscriptionRunner;
use App\Enums\FulfillmentType;
use App\Models\Subscription;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function subscribe(int $totalCycles = 3): Subscription
{
    config(['shop.subscription.total_cycles' => $totalCycles, 'shop.subscription.interval_seconds' => 5]);
    $order = app(CheckoutService::class)->placeOrder(alice(), [[
        'variant' => variant('DCS-PRO-30'), 'qty' => 1, 'fulfillment_type' => FulfillmentType::Subscription, 'appointment_at' => null,
    ]], [], (string) Str::uuid());
    app(PaymentResultHandler::class)->succeeded($order->order_no, 'txn', $order->total);

    return Subscription::firstOrFail();
}

it('訂閱：第一期付款後建立訂閱；到期時產生下一期訂單', function () {
    $sub = subscribe();
    expect($sub->cycles()->count())->toBe(1);

    $this->travel(6)->seconds();
    expect(app(SubscriptionRunner::class)->runDue())->toBe(1)
        ->and($sub->cycles()->count())->toBe(2)
        ->and(DB::table('orders')->where('subscription_id', $sub->id)->count())->toBe(2);
});

it('訂閱：排程同時跑 5 次，同一期也只有一張訂單', function () {
    $sub = subscribe();
    $this->travel(6)->seconds();

    $results = concurrently(5, function () {
        $this->travel(6)->seconds();

        return app(SubscriptionRunner::class)->runDue();
    });

    expect(collect($results)->sum('value'))->toBe(1)
        ->and($sub->cycles()->count())->toBe(2);
});

it('訂閱：跑完設定的期數就結束', function () {
    $sub = subscribe(totalCycles: 2);
    $this->travel(6)->seconds();
    app(SubscriptionRunner::class)->runDue();
    $this->travel(6)->seconds();

    expect(app(SubscriptionRunner::class)->runDue())->toBe(0)
        ->and($sub->fresh()->status)->toBe('COMPLETED');
});

it('對帳：還在佇列裡排隊（PENDING）不問；金流收下之後（SUBMITTED）才開始計時，而且用指數退避', function () {
    // 壓測抓到的：付款請求只是還在排隊，core 卻每 20 秒問一次金流 → 積壓自己放大（對帳查詢比付款請求還多）
    config(['shop.payment_reconcile_after_seconds' => 20, 'shop.payment_expire_after_seconds' => 180, 'shop.payment_reconcile_max_interval_seconds' => 300]);
    $order = app(CheckoutService::class)->placeOrder(alice(), [[
        'variant' => variant('DCS-DCAN-BEEF-165'), 'qty' => 1, 'fulfillment_type' => FulfillmentType::Direct, 'appointment_at' => null,
    ]], [], (string) Str::uuid());
    $reconciler = app(PaymentReconciler::class);
    $sent = fn () => DB::table('outbox_messages')->where('type', 'payment.reconcile.requested')->count();

    $this->travel(60)->seconds();
    expect($reconciler->run())->toBe(0);                                   // PENDING：還在排隊，不問

    app(PaymentResultHandler::class)->submitted($order->order_no, 'ch_1');  // hub：金流收下了
    $this->travel(19)->seconds();
    expect($reconciler->run())->toBe(0);                                   // 送出後還不到 20 秒
    $this->travel(2)->seconds();
    expect($reconciler->run())->toBe(1)->and($reconciler->run())->toBe(0);  // 第 1 次問；剛問過不重送

    $this->travel(39)->seconds();
    expect($reconciler->run())->toBe(0);                                   // 第 2 次要等 40 秒
    $this->travel(2)->seconds();
    expect($reconciler->run())->toBe(1)->and($sent())->toBe(2);
    expect(DB::table('payments')->where('order_id', $order->id)->value('reconcile_attempts'))->toBe(2);
});

it('不變式：一連串正常流程之後全部成立', function () {
    subscribe();
    $order = paidOrder([['DCS-LIT-1', 2], ['DCS-DCAN-BEEF-165', 1]]);
    app(SettlementRecorder::class)->recordSale($order);

    expect(collect(app(InvariantChecker::class)->check())->every(fn ($r) => $r['ok']))->toBeTrue();
});

it('混沌測試抓到的 bug：訂單已判定付款失敗，付款成功才晚到 → 自動全額退款', function () {
    $order = app(CheckoutService::class)->placeOrder(alice(), [[
        'variant' => variant('DCS-DCAN-BEEF-165'), 'qty' => 1, 'fulfillment_type' => FulfillmentType::Direct, 'appointment_at' => null,
    ]], [], (string) Str::uuid());
    $handler = app(PaymentResultHandler::class);

    $handler->failed($order->order_no, 'charge_not_found_after_expiry');      // 對帳判定失敗、釋放庫存
    $handler->succeeded($order->order_no, 'txn_late', $order->total);         // 扣款請求重試後成功了
    $handler->succeeded($order->order_no, 'txn_late', $order->total);         // 重複通知

    $refunds = DB::table('refunds')->where('order_id', $order->id)->get();
    expect($order->fresh()->status->value)->toBe('PAYMENT_FAILED')
        ->and($refunds)->toHaveCount(1)
        ->and($refunds[0]->reason)->toBe('late_payment_after_failure')
        ->and($refunds[0]->amount)->toBe($order->total)
        ->and(DB::table('outbox_messages')->where('type', 'refund.requested')->count())->toBe(1)
        ->and(collect(app(InvariantChecker::class)->check())->every(fn ($r) => $r['ok']))->toBeTrue();
});

it('對帳：只有超過付款期限，才會標記 expired；一直沒送出（PENDING）的到期時最後確認一次', function () {
    config(['shop.payment_reconcile_after_seconds' => 20, 'shop.payment_expire_after_seconds' => 180]);
    $submitted = app(CheckoutService::class)->placeOrder(alice(), [[
        'variant' => variant('DCS-DCAN-BEEF-165'), 'qty' => 1, 'fulfillment_type' => FulfillmentType::Direct, 'appointment_at' => null,
    ]], [], (string) Str::uuid());
    $neverSent = app(CheckoutService::class)->placeOrder(alice(), [[   // 扣款指令進了 DLQ：一直是 PENDING
        'variant' => variant('DCS-DCAN-BEEF-165'), 'qty' => 1, 'fulfillment_type' => FulfillmentType::Direct, 'appointment_at' => null,
    ]], [], (string) Str::uuid());
    app(PaymentResultHandler::class)->submitted($submitted->order_no, 'ch_1');
    $flags = fn () => DB::table('outbox_messages')->where('type', 'payment.reconcile.requested')->pluck('payload')
        ->map(fn ($p) => json_decode($p, true)['payload'])->map(fn ($p) => [$p['order_no'], $p['expired']])->all();

    $this->travel(21)->seconds();
    app(PaymentReconciler::class)->run();                   // 只有已送出的那筆被問，期限內 → expired=false
    $this->travel(200)->seconds();
    app(PaymentReconciler::class)->run();                   // 兩筆都過了付款期限 → expired=true

    expect($flags())->toEqualCanonicalizing([
        [$submitted->order_no, false], [$submitted->order_no, true], [$neverSent->order_no, true],
    ]);
});

it('不變式：付款失敗正常會釋放預留；忘了釋放（預留還是 HELD）要被抓到', function () {
    $order = app(CheckoutService::class)->placeOrder(alice(), [[
        'variant' => variant('DCS-DCAN-BEEF-165'), 'qty' => 1, 'fulfillment_type' => FulfillmentType::Direct, 'appointment_at' => null,
    ]], [], (string) Str::uuid());
    $leak = fn () => app(InvariantChecker::class)->check()['庫存：付款失敗、取消的訂單不能還佔著預留'];

    app(PaymentResultHandler::class)->failed($order->order_no, 'card_declined');
    expect($leak()['ok'])->toBeTrue();

    // 模擬補償漏掉：預留改回 HELD、reserved 加回去 → 「reserved = 預留加總」還是一致，只有這條抓得到
    $r = DB::table('inventory_reservations')->where('order_id', $order->id)->first();
    DB::table('inventory_reservations')->where('id', $r->id)->update(['status' => 'HELD']);
    DB::update('UPDATE inventory SET reserved = reserved + ? WHERE variant_id = ? AND bucket_no = ?', [$r->qty, $r->variant_id, $r->bucket_no]);

    $checks = app(InvariantChecker::class)->check();
    expect($leak()['ok'])->toBeFalse()
        ->and($leak()['order_nos'])->toBe([$order->order_no])
        ->and($checks['庫存：reserved = 未結案的預留加總（每一桶）']['ok'])->toBeTrue();
});
