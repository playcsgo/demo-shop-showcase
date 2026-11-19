<?php

use App\Domain\Catalog\InventoryService;
use App\Domain\Distribution\BatchSubmission;
use App\Domain\Distribution\ContractActivator;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\Distribution\ShopItemSettings;
use App\Domain\DomainException;
use App\Domain\Reconciliation\InvariantChecker;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderStatus;
use App\Models\Distributor;
use App\Models\DistributorBatch;
use App\Models\DistributorOrder;
use App\Models\DistributorShop;
use App\Models\InventoryReservation;
use Carbon\CarbonImmutable;
use Database\Seeders\DistributorDemoSeeder;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    $this->d = Distributor::where('code', 'D-PACIFIC')->firstOrFail();
    $this->buyer = distributorUser('pacific-buyer@example.test');
    $this->shops = pacificShops();
    $this->food = product('SB-DOG-FOOD')->id;
    $this->bone = product('SB-DENTAL-BONE')->id;
    $this->threeShops = stockInput([$this->shops['hk'] => [$this->food => 40], $this->shops['sg'] => [$this->food => 30], $this->shops['mo'] => [$this->food => 50]]);
});

function reservedOf(int $productId): int
{
    return (int) DB::table('inventory')->where('product_id', $productId)->sum('reserved');
}

function invariantsAreClean(): void
{
    $checks = collect(app(InvariantChecker::class)->check())->filter(fn ($c, $name) => str_starts_with($name, '庫存'));
    expect($checks->where('ok', false)->keys()->all())->toBe([]);
}

it('AC-18、AC-27：多個 shop 建立一批多張單，狀態審核中；金額、版本、事件都存下來', function () {
    $this->travelTo(CarbonImmutable::parse('2026-11-12 10:00:00', 'Asia/Taipei'));   // 週四

    $batch = app(BatchSubmission::class)->submit($this->buyer, $this->threeShops, 'k1');

    expect($batch->status)->toBe(DistributorBatchStatus::InReview)
        ->and($batch->anticipated_response_date->toDateString())->toBe('2026-11-16')
        ->and($batch->total_minor)->toBe(1080000)
        ->and($batch->prepay_minor)->toBe(324000)
        ->and($batch->currency)->toBe('USD')
        ->and($batch->revision)->toBe(1)
        ->and($batch->contract_id)->toBe($this->d->contracts()->where('status', 'active')->value('id'))
        ->and($batch->orders()->count())->toBe(3)
        ->and($batch->orders()->first()->status)->toBe(DistributorOrderStatus::Pending);
    expect($batch->revisions()->sole()->snapshot['total_minor'])->toBe(1080000);
    expect($batch->events()->sole()->type)->toBe('SUBMITTED');
});

it('AC-27：預計回覆日用台北的日期算；週五晚上（UTC 還是週五）、週六凌晨（UTC 還是週五）不同', function () {
    $this->travelTo(CarbonImmutable::parse('2026-11-14 00:30:00', 'Asia/Taipei'));   // 台北週六，UTC 週五

    expect(app(BatchSubmission::class)->submit($this->buyer, $this->threeShops, 'k1')->anticipated_response_date->toDateString())->toBe('2026-11-17');
});

it('AC-23：現貨預留箱數 × 每箱件數', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, $this->threeShops, 'k1');

    expect(reservedOf($this->food))->toBe(120 * 6);
    $order = $batch->orders()->where('shop_id', $this->shops['hk'])->sole();
    expect(InventoryReservation::where('distributor_order_id', $order->id)->sole()->qty)->toBe(240);
    invariantsAreClean();
});

it('AC-23：第二個 SKU 不足時整批不建立，第一個 SKU 的預留也退回；回 409 指出 SKU 並提示可改早鳥', function () {
    DB::table('inventory')->where('product_id', $this->bone)->update(['on_hand' => 10]);
    $input = stockInput([$this->shops['hk'] => [$this->food => 10, $this->bone => 5]]);

    expect(fn () => app(BatchSubmission::class)->submit($this->buyer, $input, 'k1'))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('insufficient_stock')->and($e->status)->toBe(409)
            ->and($e->getMessage())->toContain('SB-DENTAL-BONE')->toContain('早鳥')
            ->and($e->details['sku'])->toBe('SB-DENTAL-BONE'));

    expect(DistributorBatch::count())->toBe(0)->and(reservedOf($this->food))->toBe(0)->and(reservedOf($this->bone))->toBe(0);
    invariantsAreClean();
});

it('AC-23：同時送出搶最後的庫存：不會超賣', function () {
    DB::table('inventory')->where('product_id', $this->food)->update(['on_hand' => 60]);   // 10 箱
    $buyerId = $this->buyer->id;
    $shop = $this->shops['hk'];
    $food = $this->food;

    $results = concurrently(4, fn (int $i) => app(BatchSubmission::class)->submit(\App\Models\DistributorUser::findOrFail($buyerId), stockInput([$shop => [$food => 10]]), "race-{$i}")->id);

    expect(collect($results)->where('ok', true))->toHaveCount(1)
        ->and(reservedOf($this->food))->toBe(60)
        ->and(DistributorBatch::count())->toBe(1);
    invariantsAreClean();
});

it('兩批以相反順序買兩個 SKU：不會死結', function () {
    $buyerId = $this->buyer->id;
    $shop = $this->shops['hk'];
    [$a, $b] = [$this->food, $this->bone];

    $results = concurrently(6, function (int $i) use ($buyerId, $shop, $a, $b) {
        $pair = $i % 2 === 0 ? [$a => 1, $b => 1] : [$b => 1, $a => 1];

        return app(BatchSubmission::class)->submit(\App\Models\DistributorUser::findOrFail($buyerId), stockInput([$shop => $pair]), "order-{$i}")->id;
    });

    expect(collect($results)->where('ok', true))->toHaveCount(6);
    invariantsAreClean();
});

it('AC-24：早鳥不產生預留', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, [
        'order_type' => 'early_bird',
        'orders' => [['shop_id' => $this->shops['hk'], 'requested_ship_date' => now('Asia/Taipei')->addDays(90)->toDateString(), 'items' => [['product_id' => $this->food, 'qty_cases' => 100]]]],
    ], 'k1');

    expect(reservedOf($this->food))->toBe(0)
        ->and(InventoryReservation::where('distributor_order_id', $batch->orders()->sole()->id)->count())->toBe(0)
        ->and($batch->orders()->sole()->requested_ship_date)->not->toBeNull();
});

it('AC-25：有禁令也能送出；警告存到批次，規則之後改動不影響已存的內容', function () {
    $vitamin = product('SB-VITAMIN')->id;
    $sg = DistributorShop::findOrFail($this->shops['sg']);
    app(ShopItemSettings::class)->replace($sg, [$vitamin], distributorUser());

    $batch = app(BatchSubmission::class)->submit($this->buyer, stockInput([$sg->id => [$vitamin => 2]]), 'k1');
    expect(collect($batch->warnings)->firstWhere('sku', 'SB-VITAMIN')['banned'])->toBeTrue();

    \App\Models\CountryIngredientBan::query()->delete();
    expect(collect($batch->fresh()->warnings)->firstWhere('sku', 'SB-VITAMIN')['banned'])->toBeTrue();
});

it('AC-22：未達 MOQ 可以送出，moq_results 標示未達', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, stockInput([$this->shops['hk'] => [$this->food => 30]]), 'k1');

    expect($batch->moq_results[0]['met'])->toBeFalse();
});

it('AC-26：同一個 key 重送回同一批，預留不增加；不同公司用相同的 key 互不影響', function () {
    $first = app(BatchSubmission::class)->submit($this->buyer, $this->threeShops, 'same');
    $again = app(BatchSubmission::class)->submit($this->buyer, $this->threeShops, 'same');

    expect($again->id)->toBe($first->id)->and(reservedOf($this->food))->toBe(720)->and(DistributorBatch::count())->toBe(1);

    $north = Distributor::where('code', 'D-NORTH')->firstOrFail();
    $northUser = distributorUser('north-manager@example.test');
    $shop = $north->shops()->sole();
    app(ShopItemSettings::class)->replace($shop, [$this->food], $northUser);
    expect(app(BatchSubmission::class)->submit($northUser, stockInput([$shop->id => [$this->food => 1]]), 'same')->id)->not->toBe($first->id);
});

it('AC-26：同一個 key 同時送兩次：只有一批', function () {
    $buyerId = $this->buyer->id;
    $input = $this->threeShops;

    $results = concurrently(3, fn () => app(BatchSubmission::class)->submit(\App\Models\DistributorUser::findOrFail($buyerId), $input, 'same')->id);

    expect(collect($results)->where('ok', true)->pluck('value')->unique())->toHaveCount(1)
        ->and(DistributorBatch::count())->toBe(1)->and(reservedOf($this->food))->toBe(720);
});

it('AC-8：合約重談後，已送出的批次仍指向當時的版本', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, $this->threeShops, 'k1');
    $original = $batch->contract_id;

    $drafts = app(ContractDrafts::class);
    $draft = $drafts->copyOfActive($this->d);
    $activator = app(ContractActivator::class);
    $activator->activate($draft, staff('sales-a@example.test'));

    expect($batch->fresh()->contract_id)->toBe($original)->and($batch->fresh()->total_minor)->toBe(1080000);
});

it('AC-39：已取消的批次還佔著預留：會被抓到', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, $this->threeShops, 'k1');
    $batch->update(['status' => DistributorBatchStatus::Cancelled]);   // 模擬忘了釋放

    $check = app(InvariantChecker::class)->check()['庫存：已退回、已取消的批次不能還佔著預留'];
    expect($check['ok'])->toBeFalse()->and($check['count'])->toBe(3);
});

it('API：預覽不寫入；和送出的金額相同', function () {
    $token = distributorUser('pacific-buyer@example.test');

    $preview = $this->actingAs($token, 'distributor')->postJson('/api/v1/b2b/batches/preview', $this->threeShops)->assertOk()->json();
    expect(DistributorBatch::count())->toBe(0)->and(reservedOf($this->food))->toBe(0);

    $res = $this->actingAs($token, 'distributor')->withHeader('Idempotency-Key', 'k1')->postJson('/api/v1/b2b/batches', $this->threeShops)->assertCreated();

    expect($res->json('total_minor'))->toBe($preview['total_minor'])
        ->and($res->json('prepay_minor'))->toBe($preview['prepay_minor'])
        ->and($res->json('status'))->toBe('IN_REVIEW')
        ->and(collect($res->json('orders'))->pluck('subtotal_minor')->all())->toBe(collect($preview['orders'])->pluck('subtotal_minor')->all());
});

it('API：沒帶 Idempotency-Key 回 400；重送回同一批', function () {
    $token = distributorUser('pacific-buyer@example.test');
    $this->actingAs($token, 'distributor')->postJson('/api/v1/b2b/batches', $this->threeShops)->assertStatus(400);

    $no = $this->actingAs($token, 'distributor')->withHeader('Idempotency-Key', 'k1')->postJson('/api/v1/b2b/batches', $this->threeShops)->assertCreated()->json('batch_no');
    expect($this->actingAs($token, 'distributor')->withHeader('Idempotency-Key', 'k1')->postJson('/api/v1/b2b/batches', $this->threeShops)->assertOk()->json('batch_no'))->toBe($no);
});

it('API：格式不對 422', function () {
    $token = distributorUser('pacific-buyer@example.test');

    $this->actingAs($token, 'distributor')->postJson('/api/v1/b2b/batches/preview', ['order_type' => 'x', 'orders' => []])->assertStatus(422)->assertJson(['error' => 'validation_failed']);
    $this->actingAs($token, 'distributor')->postJson('/api/v1/b2b/batches/preview', ['order_type' => 'stock', 'orders' => [['shop_id' => $this->shops['hk'], 'items' => [['product_id' => $this->food, 'qty_cases' => 0]]]]])->assertStatus(422);
});

it('API：列表和詳情只查自己公司；別家的批次 404；', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, $this->threeShops, 'k1');
    $mine = distributorUser('pacific-buyer@example.test');

    $this->actingAs($mine, 'distributor')->getJson('/api/v1/b2b/batches')->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.batch_no', $batch->batch_no);
    $this->actingAs($mine, 'distributor')->getJson("/api/v1/b2b/batches/{$batch->batch_no}")->assertOk()
        ->assertJsonCount(3, 'orders')->assertJsonPath('orders.0.items.0.sku', 'SB-DOG-FOOD');

    $this->app['auth']->forgetGuards();
    $north = distributorUser('north-manager@example.test');
    $this->actingAs($north, 'distributor')->getJson('/api/v1/b2b/batches')->assertOk()->assertJsonCount(0, 'data');
    $this->actingAs($north, 'distributor')->getJson("/api/v1/b2b/batches/{$batch->batch_no}")->assertNotFound();

    $this->app['auth']->forgetGuards();
});

it('訂單編號和批次編號不重複', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, $this->threeShops, 'k1');

    expect(DistributorOrder::where('batch_id', $batch->id)->pluck('order_no')->unique())->toHaveCount(3);
});
