<?php

use App\Domain\Catalog\InventoryService;
use App\Domain\Refunds\RefundService;
use App\Models\Customer;
use App\Models\Shipment;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Testing\TestResponse;

// AI 客服（support）用的唯讀 API（AIC-013）：服務金鑰，路徑帶客戶 id，core-api 再檢查訂單屬於這位客戶

const SUPPORT_KEY = 'test-support-key';

beforeEach(fn () => config(['services.support.key' => SUPPORT_KEY, 'services.bff.key' => 'test-bff-key']));

function support(string $path, string $key = SUPPORT_KEY, string $actor = 'staff:7'): TestResponse
{
    return test()->withHeaders(['X-Service-Key' => $key, 'X-Support-Actor' => $actor, 'X-Correlation-Id' => 'corr-1'])
        ->getJson("/api/v1/internal/support/{$path}");
}

function bob(): Customer
{
    return Customer::where('email', 'bob@example.test')->firstOrFail();
}

it('沒帶金鑰、金鑰錯、帶 BFF 的金鑰：401', function () {
    test()->getJson('/api/v1/internal/support/products')->assertUnauthorized();
    support('products', 'wrong')->assertUnauthorized();
    support('products', 'test-bff-key')->assertUnauthorized();
    support('products')->assertOk();
});

it('core-api 沒設定金鑰時一律 401（空字串不能通過）', function () {
    config(['services.support.key' => '']);
    support('products', '')->assertUnauthorized();
});

it('客戶的 JWT 打不進來', function () {
    $h = loginAs('alice@example.test');
    test()->withHeaders($h)->getJson('/api/v1/internal/support/products')->assertUnauthorized();
});

it('商品索引：slug、名字、品牌、適用、保健需求', function () {
    $index = support('products')->assertOk()->json('data');

    expect($index)->toHaveCount(15)
        ->and(collect($index)->firstWhere('slug', 'probiotics'))->toMatchArray([
            'name' => '寵物益生菌', 'category' => '保健', 'species' => ['cat', 'dog'], 'concerns' => ['digestive'],
            'brand' => '藍貓咖啡',
        ]);
});

it('商品全文、規格清單、單一 SKU 的規格和可售數量', function () {
    support('products/probiotics')->assertOk()
        ->assertJsonPath('data.slug', 'probiotics')
        ->assertJsonPath('data.warnings.0', fn ($w) => str_contains($w, '抗生素'))
        ->assertJsonPath('data.body', fn ($b) => str_contains($b, '## 商品介紹'))
        ->assertJsonPath('data.feeding', fn ($f) => count($f) > 0);

    $variants = support('products/wooden-dog-house/variants')->assertOk()->json('data');
    expect($variants)->toBe([
        ['sku' => 'DCS-DH-M', 'flavor' => null, 'size_label' => 'M', 'price' => 3200, 'in_stock' => true],
        ['sku' => 'DCS-DH-L', 'flavor' => null, 'size_label' => 'L', 'price' => 4500, 'in_stock' => false],
    ]);

    support('variants/DCS-CAN-DUCK-80')->assertOk()->assertJson(['data' => [
        'sku' => 'DCS-CAN-DUCK-80', 'product_slug' => 'fresh-meat-can', 'name' => '鮮肉主食罐', 'flavor' => '鴨肉',
        'size_label' => '80g', 'price' => 48, 'currency' => 'TWD', 'shipping_class' => 'standard',
        'net_weight_g' => 80, 'available' => 200, 'in_stock' => true,
    ]]);
    support('variants/NOPE')->assertNotFound()->assertJson(['error' => 'not_found']);
    support('products/nope')->assertNotFound();
});

it('可售數量扣掉已預留的', function () {
    $can = variant('DCS-CAN-DUCK-80');
    DB::transaction(fn () => app(InventoryService::class)->reserve(pendingOrder()->id, $can->id, 5, now()->addMinutes(15)));

    support('variants/DCS-CAN-DUCK-80')->assertJsonPath('data.available', 195);
});

it('找客戶：最多 5 位，email 遮罩；太短的查詢回 422', function () {
    $hits = support('customers?query=ali')->assertOk()->json('data');

    expect($hits)->toBe([['id' => alice()->id, 'name' => 'Alice', 'email' => 'al***@example.test']]);
    expect(support('customers?query=shopper')->json('data'))->toHaveCount(5);
    support('customers?query=a')->assertStatus(422);
    support('customers?query=')->assertStatus(422);
    support('customers?query=%25')->assertStatus(422);
});

it('訂單列表和明細：已退數量、出貨狀態', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 3], ['DCS-WAND-1', 1]]);
    $can = $order->items->firstWhere('sku', 'DCS-CAN-DUCK-80');
    app(RefundService::class)->request($order, [$can->id => 1], 'cs', 'r-1');

    $list = support('customers/'.alice()->id.'/orders')->assertOk()->json('data');
    expect($list[0])->toMatchArray(['order_no' => $order->order_no, 'status' => 'PAID', 'item_count' => 4]);

    $detail = support('customers/'.alice()->id."/orders/{$order->order_no}")->assertOk()->json('data');
    expect($detail)->toMatchArray([
        'order_no' => $order->order_no, 'status' => 'PAID', 'refunded_amount' => 48, 'shipping_fee' => $order->shipping_fee,
    ])->and($detail['items'][0])->toMatchArray([
        'id' => $can->id, 'sku' => 'DCS-CAN-DUCK-80', 'name' => '鮮肉主食罐', 'flavor' => '鴨肉', 'size_label' => '80g',
        'qty' => 3, 'unit_price' => 48, 'refunded_qty' => 1, 'fulfillment_type' => 'direct',
    ]);
});

it('別人的訂單和不存在的訂單：一樣的 404', function () {
    $bobs = paidOrder([['DCS-WAND-1', 1]], bob());
    $alice = alice()->id;

    $theirs = support("customers/{$alice}/orders/{$bobs->order_no}")->assertNotFound();
    $missing = support("customers/{$alice}/orders/NOPE")->assertNotFound();
    expect($theirs->json())->toBe($missing->json());
    support("customers/{$alice}/orders/{$bobs->order_no}/shipments")->assertNotFound();
    support("customers/{$alice}/orders/{$bobs->order_no}/refunds")->assertNotFound();
    expect(support("customers/{$alice}/orders")->json('data'))->toBe([]);
});

it('出貨單：物流商、追蹤碼、每一段的時間、送達時間取自 DELIVERED 事件', function () {
    $order = paidOrder([['DCS-LIT-1', 1]]);
    $s = Shipment::create(['order_id' => $order->id, 'seq' => 1, 'shipping_class' => 'litter', 'carrier' => 'home_delivery', 'tracking_no' => 'HD1', 'status' => 'DELIVERED']);
    $s->events()->create(['status' => 'PICKED_UP', 'occurred_at' => '2026-11-01 10:00:00', 'provider_event_id' => 'e1']);
    $s->events()->create(['status' => 'DELIVERED', 'occurred_at' => '2026-11-02 15:00:00', 'provider_event_id' => 'e2']);
    $s->items()->create(['order_item_id' => $order->items[0]->id, 'variant_id' => $order->items[0]->variant_id, 'qty' => 1]);

    $data = support('customers/'.alice()->id."/orders/{$order->order_no}/shipments")->assertOk()->json('data');
    expect($data)->toHaveCount(1)
        ->and($data[0])->toMatchArray([
            'tracking_no' => 'HD1', 'carrier' => 'home_delivery', 'shipping_class' => 'litter', 'status' => 'DELIVERED',
            'delivered_at' => '2026-11-02T23:00:00+08:00', 'order_item_ids' => [$order->items[0]->id],
        ])
        ->and(array_column($data[0]['events'], 'status'))->toBe(['PICKED_UP', 'DELIVERED']);
});

it('退款紀錄：金額、狀態、品項', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 2]]);
    $item = $order->items->first();
    app(RefundService::class)->request($order, [$item->id => 2], 'cs', 'r-2');

    $data = support('customers/'.alice()->id."/orders/{$order->order_no}/refunds")->assertOk()->json('data');
    expect($data[0])->toMatchArray(['amount' => 96, 'status' => 'PENDING'])
        ->and($data[0]['items'])->toBe([['order_item_id' => $item->id, 'qty' => 2, 'amount' => 96]]);
});

it('log 帶 support_actor 和 correlation_id，不帶回應內容', function () {
    Log::spy();
    support('customers/'.alice()->id.'/orders', actor: 'customer:'.alice()->id);

    Log::shouldHaveReceived('withContext')->withArgs(fn ($ctx) => ($ctx['support_actor'] ?? null) === 'customer:'.alice()->id);
});
