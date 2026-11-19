<?php

use App\Models\Order;
use Illuminate\Support\Facades\Http;

// AI 客服 demo 用的訂單（AIC-014）：support 透過 internal API 看到的樣子

beforeEach(function () {
    config(['services.support.key' => 'k']);
    Http::fake(['*/admin/charges' => Http::response(['ok' => true])]);
});

function supportGet(string $path): array
{
    return test()->withHeaders(['X-Service-Key' => 'k'])->getJson("/api/v1/internal/support/{$path}")->assertOk()->json('data');
}

it('DEMO-A～E：可以重跑，不會重複', function () {
    $this->artisan('support:demo-orders')->assertSuccessful();
    $this->artisan('support:demo-orders')->assertSuccessful();

    expect(Order::where('order_no', 'like', 'DEMO-%')->orderBy('order_no')->pluck('order_no')->all())
        ->toBe(['DEMO-A', 'DEMO-B', 'DEMO-C', 'DEMO-D', 'DEMO-E']);
});

it('送達時間：A 三天前、B 三十天前、E 剛過七天；C 還在運送中', function () {
    $this->artisan('support:demo-orders');
    $alice = alice()->id;
    $deliveredDaysAgo = fn (string $no) => now()->diffInHours(Carbon\Carbon::parse(supportGet("customers/{$alice}/orders/{$no}/shipments")[0]['delivered_at'])) / -24;

    expect(round($deliveredDaysAgo('DEMO-A')))->toBe(3.0)
        ->and(round($deliveredDaysAgo('DEMO-B')))->toBe(30.0)
        ->and($deliveredDaysAgo('DEMO-E'))->toBeGreaterThan(7.0)->toBeLessThan(7.5)
        ->and(supportGet("customers/{$alice}/orders/DEMO-C/shipments")[0])->toMatchArray(['status' => 'IN_TRANSIT', 'delivered_at' => null, 'shipping_class' => 'litter']);
});

it('DEMO-A 已付款、已完成，明細照價格算；DEMO-D 是 bob 的', function () {
    $this->artisan('support:demo-orders');

    $a = supportGet('customers/'.alice()->id.'/orders/DEMO-A');
    expect($a)->toMatchArray(['status' => 'COMPLETED', 'paid' => true, 'total' => 590 + 48 * 6, 'refunded_amount' => 0])
        ->and(collect($a['items'])->pluck('sku')->all())->toBe(['DCS-PRO-30', 'DCS-CAN-DUCK-80']);
    $this->withHeaders(['X-Service-Key' => 'k'])->getJson('/api/v1/internal/support/customers/'.alice()->id.'/orders/DEMO-D')->assertNotFound();
});

it('每次都在假金流登記 DEMO 訂單的扣款（退款時金流才找得到）', function () {
    $this->artisan('support:demo-orders');
    $this->artisan('support:demo-orders');

    Http::assertSentCount(10);
    Http::assertSent(fn ($r) => str_ends_with($r->url(), '/admin/charges')
        && $r['charge_id'] === 'txn_demo_DEMO-A' && $r['order_no'] === 'DEMO-A' && $r['amount'] === 590 + 48 * 6);
});
