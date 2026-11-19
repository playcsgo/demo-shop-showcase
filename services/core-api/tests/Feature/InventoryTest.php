<?php

use App\Domain\Catalog\InventoryService;
use App\Domain\DomainException;
use App\Models\Inventory;
use Illuminate\Support\Facades\DB;

beforeEach(fn () => $this->inventory = app(InventoryService::class));

it('庫存不足時預留失敗，不會建立預留紀錄', function () {
    $doghouse = variant('DCS-DH-M'); // 庫存 6
    $order = pendingOrder();

    expect(fn () => DB::transaction(fn () => $this->inventory->reserve($order->id, $doghouse->id, 7, now()->addMinutes(15))))
        ->toThrow(DomainException::class);

    expect(Inventory::totals($doghouse->id)->reserved)->toBe(0)
        ->and(DB::table('inventory_reservations')->count())->toBe(0);
});

it('100 個程序同時搶 10 件庫存：剛好 10 個成功，不會超賣', function () {
    $doghouse = variant('DCS-DH-M');
    Inventory::where('variant_id', $doghouse->id)->update(['on_hand' => 10]);
    $orderIds = collect(range(1, 100))->map(fn () => pendingOrder()->id)->all();

    $results = concurrently(100, fn (int $i) => DB::transaction(
        fn () => $this->inventory->reserve($orderIds[$i], $doghouse->id, 1, now()->addMinutes(15))
    ));

    $stock = Inventory::totals($doghouse->id);
    expect(collect($results)->where('ok', true))->toHaveCount(10)
        ->and(collect($results)->where('error', 'insufficient_stock'))->toHaveCount(90)
        ->and($stock->reserved)->toBe(10)
        ->and($stock->on_hand)->toBe(10)
        ->and(DB::table('inventory_reservations')->count())->toBe(10);
});

it('付款成功實扣、重複通知只扣一次；付款失敗釋放', function () {
    $chews = variant('DCS-CAL-60'); // 庫存 50
    $paid = pendingOrder();
    $failed = pendingOrder();
    DB::transaction(function () use ($paid, $failed, $chews) {
        $this->inventory->reserve($paid->id, $chews->id, 2, now()->addMinutes(15));
        $this->inventory->reserve($failed->id, $chews->id, 3, now()->addMinutes(15));
    });

    $this->inventory->commit($paid->id);
    $this->inventory->commit($paid->id);   // 重複的付款成功通知
    $this->inventory->release($failed->id);
    $this->inventory->release($failed->id);

    $stock = Inventory::totals($chews->id);
    expect($stock->on_hand)->toBe(48)->and($stock->reserved)->toBe(0);
});
