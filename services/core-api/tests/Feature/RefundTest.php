<?php

use App\Domain\DomainException;
use App\Domain\Refunds\RefundService;
use Illuminate\Support\Facades\DB;

it('部分退款：只退其中一項，訂單其他明細不受影響', function () {
    $order = paidOrder([['DCS-DCAN-BEEF-165', 2], ['DCS-WAND-1', 1]]);
    $can = $order->items->firstWhere('sku', 'DCS-DCAN-BEEF-165');

    $refund = app(RefundService::class)->request($order, [$can->id => 1], 'customer_request', 'r-1');

    expect($refund->amount)->toBe(75)
        ->and($can->fresh()->refunded_qty)->toBe(1)
        ->and($order->payment->fresh()->refunded_amount)->toBe(75)
        ->and(DB::table('outbox_messages')->where('type', 'refund.requested')->count())->toBe(1);
});

it('退款數量超過購買數量會被拒絕', function () {
    $order = paidOrder([['DCS-DCAN-BEEF-165', 1]]);
    $item = $order->items->first();

    expect(fn () => app(RefundService::class)->request($order, [$item->id => 2], 'customer_request', 'r-1'))
        ->toThrow(DomainException::class);
});

it('20 個客服同時退同一項（只買 1 個）：只有 1 筆退款成立', function () {
    $order = paidOrder([['DCS-CAL-60', 1]]);
    $item = $order->items->first();

    $results = concurrently(20, fn (int $i) => app(RefundService::class)
        ->request($order, [$item->id => 1], 'cs', "r-{$i}")->id);

    expect(collect($results)->where('ok', true))->toHaveCount(1)
        ->and(DB::table('refunds')->count())->toBe(1)
        ->and($item->fresh()->refunded_qty)->toBe(1)
        ->and($order->payment->fresh()->refunded_amount)->toBe(450);
});
