<?php

use App\Domain\Fulfillment\FulfillmentDispatcher;
use App\Domain\Warehouse\WarehouseService;
use App\Models\Shipment;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

// 物流（AIC-017）：出貨訊息帶運送類別；AI 客服問預估送達時間時，core-api 經 hub 問物流商

beforeEach(fn () => config(['services.support.key' => 'k']));

function estimateOf(string $sku)
{
    return test()->withHeaders(['X-Service-Key' => 'k'])->getJson("/api/v1/internal/support/variants/{$sku}/delivery-estimate");
}

it('直送的出貨訊息帶 shipping_class：貓砂和一般商品同一個物流商，物流商才分得出來', function () {
    $order = paidOrder([['DCS-LIT-1', 1], ['DCS-CAN-DUCK-80', 1]]);
    DB::transaction(fn () => app(FulfillmentDispatcher::class)->dispatch($order));

    $payloads = DB::table('outbox_messages')->where('type', 'shipment.requested')->pluck('payload')->map(fn ($p) => json_decode($p, true)['payload']);   // outbox 存的是信封
    expect($payloads->pluck('shipping_class')->sort()->values()->all())->toBe(['litter', 'standard'])
        ->and($payloads->pluck('carrier')->unique()->values()->all())->toBe(['home_delivery']);
});

it('寄倉提領的出貨訊息也帶 shipping_class', function () {
    $alice = alice();
    $litter = variant('DCS-LIT-1');
    app(WarehouseService::class)->deposit($alice->id, $litter->id, 3, 'test', 1, 'dep-1');
    app(WarehouseService::class)->withdraw($alice->id, $litter->id, 1, 'wd-1', 'corr-1');

    $p = json_decode(DB::table('outbox_messages')->where('type', 'shipment.requested')->value('payload'), true)['payload'];
    expect($p['shipping_class'])->toBe('litter');
});

it('預估：照 SKU 的運送類別問 hub，回傳物流商的預估和有沒有貨', function () {
    Http::fake(['*/internal/logistics/estimate*' => Http::response(['shipping_class' => 'litter', 'estimated_seconds' => 1200, 'slow' => true])]);

    estimateOf('DCS-LIT-1')->assertOk()->assertJson(['data' => [
        'sku' => 'DCS-LIT-1', 'shipping_class' => 'litter', 'estimated_seconds' => 1200, 'slow' => true, 'in_stock' => true,
    ]]);
    Http::assertSent(fn ($r) => str_contains($r->url(), 'shipping_class=litter') && $r->hasHeader('x-internal-key'));
});

it('hub 或物流商掛了：503，不給假的預估；服務類和不存在的 SKU：404', function () {
    Http::fake(['*' => Http::response(['error' => 'logistics_unavailable'], 503)]);
    estimateOf('DCS-LIT-1')->assertStatus(503)->assertJson(['error' => 'logistics_unavailable']);
    estimateOf('DCS-SVC-HEALTH')->assertNotFound();
    estimateOf('NOPE')->assertNotFound();
});

it('給 AI 客服的時間是台灣時間（+08:00）：AI 不會把 UTC 當成本地時間講', function () {
    $this->travelTo('2026-11-02 07:00:00');   // UTC
    $order = paidOrder([['DCS-LIT-1', 1]]);
    $s = Shipment::create(['order_id' => $order->id, 'seq' => 1, 'shipping_class' => 'litter', 'carrier' => 'home_delivery', 'tracking_no' => 'TZ1', 'status' => 'DELIVERED']);
    $s->events()->create(['status' => 'DELIVERED', 'occurred_at' => now(), 'provider_event_id' => 'tz']);

    $data = test()->withHeaders(['X-Service-Key' => 'k'])->getJson('/api/v1/internal/support/customers/'.alice()->id."/orders/{$order->order_no}/shipments")->json('data.0');
    expect($data['delivered_at'])->toBe('2026-11-02T15:00:00+08:00')
        ->and($data['events'][0]['at'])->toBe('2026-11-02T15:00:00+08:00');
});
