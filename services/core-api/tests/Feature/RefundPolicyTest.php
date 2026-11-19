<?php

use App\Domain\DomainException;
use App\Domain\Refunds\RefundCompletion;
use App\Domain\Refunds\RefundPolicy;
use App\Domain\Refunds\RefundService;
use App\Filament\Resources\Orders\Pages\ViewOrder;
use App\Models\Order;
use App\Models\Shipment;
use App\Models\User;
use Illuminate\Support\Facades\DB;

// 退款政策（AIC-016）：每個品項看自己出貨單送達的時間，超過 7 天不能退；還沒送達的不受期限限制

/** 讓這張訂單的某些品項在 $daysAgo 天前送達（一張出貨單） */
function deliver(Order $order, array $skus, float $daysAgo, int $seq = 1): void
{
    $s = Shipment::create(['order_id' => $order->id, 'seq' => $seq, 'shipping_class' => 'standard', 'carrier' => 'home_delivery',
        'tracking_no' => "T{$order->id}-{$seq}", 'status' => 'DELIVERED']);
    foreach ($order->items->whereIn('sku', $skus) as $item) {
        $s->items()->create(['order_item_id' => $item->id, 'variant_id' => $item->variant_id, 'qty' => $item->qty]);
    }
    $s->events()->create(['status' => 'DELIVERED', 'occurred_at' => now()->subMinutes((int) round($daysAgo * 1440)), 'provider_event_id' => "e{$order->id}-{$seq}"]);
}

function lineOf(Order $order, string $sku, int $qty = 1): array
{
    return [$order->items->firstWhere('sku', $sku)->id => $qty];
}

it('送達 7 天內可退；金額照明細算', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 3]]);
    deliver($order, ['DCS-CAN-DUCK-80'], 3);

    expect(app(RefundPolicy::class)->evaluate($order, lineOf($order, 'DCS-CAN-DUCK-80', 2)))
        ->toBe(['eligible' => true, 'code' => null, 'amount' => 96]);
});

it('超過 7 天：refund_window_expired；正好 7 天還可以退', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 1], ['DCS-WAND-1', 1]]);
    deliver($order, ['DCS-CAN-DUCK-80'], 7.1, 1);
    deliver($order, ['DCS-WAND-1'], 6.99, 2);
    $policy = app(RefundPolicy::class);

    expect($policy->evaluate($order, lineOf($order, 'DCS-CAN-DUCK-80'))['code'])->toBe('refund_window_expired')
        ->and($policy->evaluate($order, lineOf($order, 'DCS-WAND-1'))['eligible'])->toBeTrue();
});

it('AC-48：一張訂單兩個出貨單，3 天前送達的可退、10 天前送達的不行', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 1], ['DCS-LIT-1', 1]]);
    deliver($order, ['DCS-CAN-DUCK-80'], 3, 1);
    deliver($order, ['DCS-LIT-1'], 10, 2);
    $policy = app(RefundPolicy::class);

    expect($policy->evaluate($order, lineOf($order, 'DCS-CAN-DUCK-80'))['eligible'])->toBeTrue()
        ->and($policy->evaluate($order, lineOf($order, 'DCS-LIT-1'))['code'])->toBe('refund_window_expired')
        ->and($policy->evaluate($order, lineOf($order, 'DCS-CAN-DUCK-80') + lineOf($order, 'DCS-LIT-1'))['code'])->toBe('refund_window_expired');
});

it('還沒送達的不受期限限制', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 1]]);
    expect(app(RefundPolicy::class)->evaluate($order, lineOf($order, 'DCS-CAN-DUCK-80'))['eligible'])->toBeTrue();
});

it('明細不屬於這張訂單、數量不合法、超過可退數量：各自的代碼', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 2]]);
    $other = paidOrder([['DCS-WAND-1', 1]]);
    $policy = app(RefundPolicy::class);

    expect($policy->evaluate($order, [])['code'])->toBe('invalid_lines')
        ->and($policy->evaluate($order, lineOf($other, 'DCS-WAND-1'))['code'])->toBe('invalid_lines')
        ->and($policy->evaluate($order, lineOf($order, 'DCS-CAN-DUCK-80', 0))['code'])->toBe('invalid_lines')
        ->and($policy->evaluate($order, lineOf($order, 'DCS-CAN-DUCK-80', 3))['code'])->toBe('refund_exceeds_qty');
});

it('RefundService 超過期限擋下，數量和金額都沒動；帶例外原因就可以退，並且記錄', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 2]]);
    deliver($order, ['DCS-CAN-DUCK-80'], 10);
    $item = $order->items->first();

    expect(fn () => app(RefundService::class)->request($order, [$item->id => 1], 'cs', 'r-1'))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('refund_window_expired'));
    expect($item->fresh()->refunded_qty)->toBe(0)->and($order->payment->fresh()->refunded_amount)->toBe(0);

    $refund = app(RefundService::class)->request($order, [$item->id => 1], 'cs', 'r-2', requestedBy: 'admin:1', overrideReason: '客戶過敏，主管同意');
    expect($refund->fresh())->requested_by->toBe('admin:1')->override_reason->toBe('客戶過敏，主管同意');
});

it('AC-50：退一部分 → PARTIALLY_REFUNDED；全部退完 → REFUNDED', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 2]]);
    $item = $order->items->first();
    $first = app(RefundService::class)->request($order, [$item->id => 1], 'cs', 'r-a');
    app(RefundCompletion::class)->succeeded(['refund_id' => $first->id, 'provider_refund_id' => 'p1']);
    expect($order->fresh()->status->value)->toBe('PARTIALLY_REFUNDED');

    $second = app(RefundService::class)->request($order->fresh(), [$item->id => 1], 'cs', 'r-b');
    app(RefundCompletion::class)->succeeded(['refund_id' => $second->id, 'provider_refund_id' => 'p2']);
    expect($order->fresh()->status->value)->toBe('REFUNDED');
});

it('RefundPolicy 的期限是 7 天（和 support 的退款 SOP §S2 一致）', function () {
    expect(RefundPolicy::WINDOW_DAYS)->toBe(7);
});

it('AC-52：同一個冪等鍵並發 10 次 → 一筆退款', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 3]]);
    $item = $order->items->first();

    concurrently(10, fn () => app(RefundService::class)->request($order, [$item->id => 1], 'cs', 'support-proposal:x')->id);

    expect(DB::table('refunds')->count())->toBe(1)->and($item->fresh()->refunded_qty)->toBe(1);
});

it('AC-51：後台退款超過期限被擋；勾例外沒填原因也被擋；填了原因才退，記下是誰', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 2]]);
    deliver($order, ['DCS-CAN-DUCK-80'], 10);
    $admin = User::where('email', 'admin@example.test')->firstOrFail();
    $this->actingAs($admin);
    $item = $order->items->first();
    $page = fn () => Livewire\Livewire::test(ViewOrder::class, ['record' => $order->getRouteKey()]);

    $page()->callAction('refund', ['order_item_id' => $item->id, 'qty' => 1]);
    expect(DB::table('refunds')->count())->toBe(0);

    $page()->callAction('refund', ['order_item_id' => $item->id, 'qty' => 1, 'override' => true, 'override_reason' => ''])
        ->assertHasActionErrors(['override_reason' => 'required']);
    expect(DB::table('refunds')->count())->toBe(0);

    $page()->callAction('refund', ['order_item_id' => $item->id, 'qty' => 1, 'override' => true, 'override_reason' => '客戶過敏，主管同意']);
    expect(DB::table('refunds')->first())
        ->requested_by->toBe("admin:{$admin->id}")
        ->override_reason->toBe('客戶過敏，主管同意');
});

it('壓測用的隨機退款不受期限限制', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 2]]);
    deliver($order, ['DCS-CAN-DUCK-80'], 30);

    $this->artisan('dev:refund-random', ['count' => 5])->assertSuccessful();
    expect(DB::table('refunds')->where('requested_by', 'load_test')->count())->toBe(1);
});
