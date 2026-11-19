<?php

use App\Domain\Warehouse\WarehouseService;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    $this->warehouse = app(WarehouseService::class);
    $this->food = variant('DCS-DCAN-BEEF-165X12');
});

it('同一筆入帳重複執行只記一次', function () {
    $c = alice();
    expect($this->warehouse->deposit($c->id, $this->food->id, 10, 'order_item', 1, 'deposit:1'))->toBeTrue()
        ->and($this->warehouse->deposit($c->id, $this->food->id, 10, 'order_item', 1, 'deposit:1'))->toBeFalse()
        ->and(DB::table('warehouse_accounts')->value('balance'))->toBe(10);
});

it('100 個程序同時各提領 1 包、餘額只有 50：剛好 50 個成功、餘額 0、帳本加總一致', function () {
    $c = alice();
    $this->warehouse->deposit($c->id, $this->food->id, 50, 'order_item', 1, 'deposit:1');

    $results = concurrently(100, fn (int $i) => $this->warehouse
        ->withdraw($c->id, $this->food->id, 1, "w-{$i}", 'corr')->id);

    expect(collect($results)->where('ok', true))->toHaveCount(50)
        ->and(collect($results)->where('error', 'insufficient_balance'))->toHaveCount(50)
        ->and(DB::table('warehouse_accounts')->value('balance'))->toBe(0)
        ->and($this->warehouse->mismatchedAccounts())->toBe([])
        ->and(DB::table('withdrawals')->count())->toBe(50)
        ->and(DB::table('outbox_messages')->where('type', 'shipment.requested')->count())->toBe(50);
});

it('同一個提領請求同時送 10 次（同一個冪等鍵）：只扣一次', function () {
    $c = alice();
    $this->warehouse->deposit($c->id, $this->food->id, 10, 'order_item', 1, 'deposit:1');

    $results = concurrently(10, fn () => $this->warehouse->withdraw($c->id, $this->food->id, 3, 'same-key', 'corr')->id);

    expect(collect($results)->pluck('value')->unique())->toHaveCount(1)
        ->and(DB::table('withdrawals')->count())->toBe(1)
        ->and(DB::table('warehouse_accounts')->value('balance'))->toBe(7)
        ->and($this->warehouse->mismatchedAccounts())->toBe([]);
});
