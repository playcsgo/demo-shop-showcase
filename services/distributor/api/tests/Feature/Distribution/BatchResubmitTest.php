<?php

use App\Domain\Distribution\BatchReview;
use App\Domain\Distribution\BatchSubmission;
use App\Domain\Distribution\ContractActivator;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\DomainException;
use App\Domain\Reconciliation\InvariantChecker;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderType;
use App\Models\Distributor;
use App\Models\DistributorBatch;
use App\Models\DistributorOrder;
use App\Models\InventoryReservation;
use Database\Seeders\DistributorDemoSeeder;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    $this->sales = staff('sales-a@example.test');
    $this->buyer = distributorUser('pacific-buyer@example.test');
    $this->shops = pacificShops();
    $this->food = product('SB-DOG-FOOD')->id;
    $this->submission = app(BatchSubmission::class);
    $this->batch = $this->submission->submit($this->buyer, stockInput([$this->shops['hk'] => [$this->food => 40], $this->shops['sg'] => [$this->food => 30]]), 'k1');
    app(BatchReview::class)->reject($this->batch, $this->sales, '數量請再確認');
});

function foodReserved(): int
{
    return (int) DB::table('inventory')->where('product_id', test()->food)->sum('reserved');
}

function cleanStock(): void
{
    expect(collect(app(InvariantChecker::class)->check())->filter(fn ($c, $n) => str_starts_with($n, '庫存'))->where('ok', false)->keys()->all())->toBe([]);
}

it('AC-30：同一個 shop 重送後單號不變；重新預留不會撞唯一鍵；回到審核中、版本加一', function () {
    $hkNo = $this->batch->orders()->where('shop_id', $this->shops['hk'])->value('order_no');

    $batch = $this->submission->resubmit($this->buyer, $this->batch, stockInput([$this->shops['hk'] => [$this->food => 60], $this->shops['sg'] => [$this->food => 50]]));

    expect($batch->status)->toBe(DistributorBatchStatus::InReview)
        ->and($batch->revision)->toBe(2)
        ->and($batch->total_minor)->toBe(110 * 9000)
        ->and($batch->reviewed_by_user_id)->toBeNull()
        ->and($batch->orders()->where('shop_id', $this->shops['hk'])->value('order_no'))->toBe($hkNo)
        ->and(foodReserved())->toBe(110 * 6)
        ->and(InventoryReservation::whereIn('distributor_order_id', $batch->orders()->pluck('id'))->where('status', 'RELEASED')->count())->toBe(0);
    cleanStock();
});

it('AC-30：訂單 id 和 shop id 不同時，重送也不會刪掉留下來的單', function () {
    // 先用掉幾個訂單 id：Eloquent Collection 的 except 比的是主鍵，id 剛好相同時看不出來
    $this->submission->submit($this->buyer, stockInput([$this->shops['hk'] => [$this->food => 1], $this->shops['sg'] => [$this->food => 1], $this->shops['mo'] => [$this->food => 1]]), 'burn-order-ids');
    $batch = $this->submission->submit($this->buyer, stockInput([$this->shops['hk'] => [$this->food => 40], $this->shops['sg'] => [$this->food => 30]]), 'ids-differ');
    app(BatchReview::class)->reject($batch, $this->sales, '數量請再確認');
    $orders = $batch->orders()->pluck('order_no', 'shop_id')->all();

    $again = $this->submission->resubmit($this->buyer, $batch->fresh(), stockInput([$this->shops['hk'] => [$this->food => 40], $this->shops['mo'] => [$this->food => 30]]));

    $after = $again->orders()->pluck('order_no', 'shop_id');
    expect($after[$this->shops['hk']])->toBe($orders[$this->shops['hk']])
        ->and($after->has($this->shops['sg']))->toBeFalse()
        ->and($after->has($this->shops['mo']))->toBeTrue();
    cleanStock();
});

it('AC-30：重送後價格按當下的 active 合約重算', function () {
    $d = Distributor::where('code', 'D-PACIFIC')->firstOrFail();
    $drafts = app(ContractDrafts::class);
    $draft = $drafts->copyOfActive($d);
    $terms = $draft->toTerms();
    foreach ($terms['items'] as &$item) {
        foreach ($item['tiers'] as &$tier) {
            $tier['unit_price_minor'] += 100;
        }
    }
    unset($item, $tier);
    $drafts->save($draft, $terms);
    $activator = app(ContractActivator::class);
    $activator->activate($draft->fresh(), $this->sales);

    $batch = $this->submission->resubmit($this->buyer, $this->batch, stockInput([$this->shops['hk'] => [$this->food => 1]]));

    expect($batch->contract_id)->toBe($draft->id)->and($batch->total_minor)->toBe(10100);
});

it('AC-30：拿掉一個 shop、加上新 shop 都能重送；事件還在', function () {
    $sgOrderId = $this->batch->orders()->where('shop_id', $this->shops['sg'])->value('id');
    DB::table('distributor_order_events')->insert(['batch_id' => $this->batch->id, 'order_id' => $sgOrderId, 'type' => 'TEST', 'actor_type' => 'user', 'occurred_at' => now()]);

    $batch = $this->submission->resubmit($this->buyer, $this->batch, stockInput([$this->shops['hk'] => [$this->food => 10], $this->shops['mo'] => [$this->food => 10]]));

    expect($batch->orders()->pluck('shop_id')->sort()->values()->all())->toBe(collect([$this->shops['hk'], $this->shops['mo']])->sort()->values()->all())
        ->and(DistributorOrder::find($sgOrderId))->toBeNull()
        ->and(DB::table('distributor_order_events')->where('type', 'TEST')->value('order_id'))->toBeNull()
        ->and(foodReserved())->toBe(120);
    cleanStock();
});

it('AC-30：現貨改早鳥能重送，不留預留；早鳥改現貨會預留', function () {
    $early = ['order_type' => 'early_bird', 'orders' => [['shop_id' => $this->shops['hk'], 'requested_ship_date' => now('Asia/Taipei')->addDays(90)->toDateString(), 'items' => [['product_id' => $this->food, 'qty_cases' => 100]]]]];

    $batch = $this->submission->resubmit($this->buyer, $this->batch, $early);
    expect($batch->order_type)->toBe(DistributorOrderType::EarlyBird)->and(foodReserved())->toBe(0)->and($batch->total_minor)->toBe(873000);

    app(BatchReview::class)->reject($batch, $this->sales, '再改');
    $batch = $this->submission->resubmit($this->buyer, $batch, stockInput([$this->shops['hk'] => [$this->food => 10]]));
    expect($batch->order_type)->toBe(DistributorOrderType::Stock)->and(foodReserved())->toBe(60)
        ->and($batch->orders()->sole()->requested_ship_date)->toBeNull();
    cleanStock();
});

it('AC-30：交期已不夠遠時，早鳥重送被拒，狀態維持 REJECTED', function () {
    $early = ['order_type' => 'early_bird', 'orders' => [['shop_id' => $this->shops['hk'], 'requested_ship_date' => now('Asia/Taipei')->addDays(5)->toDateString(), 'items' => [['product_id' => $this->food, 'qty_cases' => 1]]]]];

    expect(fn () => $this->submission->resubmit($this->buyer, $this->batch, $early))->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('ship_date_too_soon'));
    expect($this->batch->fresh()->status)->toBe(DistributorBatchStatus::Rejected)->and($this->batch->fresh()->revision)->toBe(1);
});

it('AC-30：現貨重送時庫存不足回 409，保持 REJECTED，舊內容還在', function () {
    DB::table('inventory')->where('product_id', $this->food)->update(['on_hand' => 6]);
    $before = $this->batch->fresh()->total_minor;

    expect(fn () => $this->submission->resubmit($this->buyer, $this->batch, stockInput([$this->shops['hk'] => [$this->food => 10]])))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('insufficient_stock')->and($e->status)->toBe(409));

    expect($this->batch->fresh()->status)->toBe(DistributorBatchStatus::Rejected)
        ->and($this->batch->fresh()->total_minor)->toBe($before)
        ->and($this->batch->orders()->count())->toBe(2)
        ->and(foodReserved())->toBe(0);
    cleanStock();
});

it('AC-30：IN_REVIEW 時重送被拒；重複送只有第一次生效', function () {
    $input = stockInput([$this->shops['hk'] => [$this->food => 10]]);
    $this->submission->resubmit($this->buyer, $this->batch, $input);

    expect(fn () => $this->submission->resubmit($this->buyer, $this->batch->fresh(), $input))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('batch_status_changed')->and($e->status)->toBe(409));
    expect($this->batch->fresh()->revision)->toBe(2)->and(foodReserved())->toBe(60);
});

it('AC-30：同時重送兩次：只有一次生效', function () {
    $buyerId = $this->buyer->id;
    $batchId = $this->batch->id;
    $input = stockInput([$this->shops['hk'] => [$this->food => 10]]);

    $results = concurrently(2, fn () => app(BatchSubmission::class)->resubmit(\App\Models\DistributorUser::findOrFail($buyerId), DistributorBatch::findOrFail($batchId), $input)->id);

    expect(collect($results)->where('ok', true))->toHaveCount(1)->and($this->batch->fresh()->revision)->toBe(2)->and(foodReserved())->toBe(60);
    cleanStock();
});

it('AC-30：API 重送和版本：歷次內容和退回原因都查得到；別家 404', function () {
    $token = distributorUser('pacific-buyer@example.test');
    $url = "/api/v1/b2b/batches/{$this->batch->batch_no}";

    $this->actingAs($token, 'distributor')->getJson($url)->assertOk()->assertJsonPath('reject_reason', '數量請再確認');

    $this->actingAs($token, 'distributor')->putJson($url, stockInput([$this->shops['hk'] => [$this->food => 10]]))->assertOk()
        ->assertJsonPath('status', 'IN_REVIEW')->assertJsonPath('revision', 2)->assertJsonPath('reject_reason', null);
    $this->actingAs($token, 'distributor')->putJson($url, stockInput([$this->shops['hk'] => [$this->food => 10]]))->assertStatus(409);

    $revisions = $this->actingAs($token, 'distributor')->getJson("{$url}/revisions")->assertOk()->json('data');
    expect($revisions)->toHaveCount(2)
        ->and($revisions[0]['revision'])->toBe(1)
        ->and($revisions[0]['reject_reason'])->toBe('數量請再確認')
        ->and($revisions[0]['total_minor'])->toBe(665000)
        ->and($revisions[1]['reject_reason'])->toBeNull()
        ->and(json_encode($revisions))->not->toContain('rejected_by');

    $this->app['auth']->forgetGuards();
    $north = distributorUser('north-manager@example.test');
    $this->actingAs($north, 'distributor')->getJson("{$url}/revisions")->assertNotFound();
    $this->actingAs($north, 'distributor')->putJson($url, stockInput([$this->shops['hk'] => [$this->food => 10]]))->assertNotFound();
});
