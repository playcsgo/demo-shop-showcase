<?php

use App\Domain\Catalog\InventoryBuckets;
use App\Domain\Catalog\InventoryService;
use App\Domain\DomainException;
use App\Domain\Reconciliation\InvariantChecker;
use App\Models\Inventory;
use App\Models\ProductVariant;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    $this->inventory = app(InventoryService::class);
    $this->buckets = app(InventoryBuckets::class);
});

/** bucket_no => [on_hand, reserved] */
function bucketsOf(ProductVariant $v): array
{
    return DB::table('inventory')->where('variant_id', $v->id)->orderBy('bucket_no')->get()
        ->mapWithKeys(fn ($r) => [$r->bucket_no => [(int) $r->on_hand, (int) $r->reserved]])->all();
}

function setStock(ProductVariant $v, int $qty): void
{
    Inventory::where('variant_id', $v->id)->update(['on_hand' => $qty, 'reserved' => 0]);
}

function splitInto(ProductVariant $v, int $n): void
{
    app(InventoryBuckets::class)->setTarget($v, $n);
    app(InventoryBuckets::class)->converge($v->id);
}

function reserveFor(ProductVariant $v, int $qty): int
{
    $order = pendingOrder();
    DB::transaction(fn () => app(InventoryService::class)->reserve($order->id, $v->id, $qty, now()->addMinutes(15)));

    return $order->id;
}

it('拆桶：想要 8 桶 → 收斂成 8 桶、平均分配，總數不變', function () {
    $collar = variant('DCS-CAL-60');
    setStock($collar, 800);

    splitInto($collar, 8);

    expect(bucketsOf($collar))->toHaveCount(8)
        ->and(collect(bucketsOf($collar))->every(fn ($b) => $b[0] === 100))->toBeTrue()
        ->and(Inventory::totals($collar->id)->on_hand)->toBe(800)
        ->and($collar->fresh()->hot_mode)->toBe('manual');
});

it('庫存少的商品少拆幾桶：每桶至少 20 件', function () {
    $collar = variant('DCS-CAL-60');
    setStock($collar, 50);

    splitInto($collar, 8);

    expect(bucketsOf($collar))->toHaveCount(2);   // 50 ÷ 20 = 2
});

it('預留分散在各桶；實扣、釋放回到預留的那一桶；不變式成立', function () {
    $collar = variant('DCS-CAL-60');
    setStock($collar, 800);
    splitInto($collar, 8);

    $paid = reserveFor($collar, 2);
    $failed = reserveFor($collar, 3);
    $this->inventory->commit($paid);
    $this->inventory->release($failed);

    expect(Inventory::totals($collar->id))->on_hand->toBe(798)->reserved->toBe(0)
        ->and(collect(app(InvariantChecker::class)->check())->every(fn ($r) => $r['ok']))->toBeTrue();
});

it('快賣完、貨散在好幾桶：一張訂單從好幾桶湊，一桶一筆預留', function () {
    $collar = variant('DCS-CAL-60');
    setStock($collar, 160);
    splitInto($collar, 8);
    // 每桶只剩 1 件可賣
    DB::table('inventory')->where('variant_id', $collar->id)->update(['on_hand' => 1]);

    $order = reserveFor($collar, 3);

    expect(DB::table('inventory_reservations')->where('order_id', $order)->count())->toBe(3)
        ->and(Inventory::totals($collar->id)->reserved)->toBe(3);

    $this->inventory->commit($order);
    expect(Inventory::totals($collar->id))->on_hand->toBe(5)->reserved->toBe(0);
});

it('所有桶加起來不夠：預留失敗，哪一桶都沒動', function () {
    $collar = variant('DCS-CAL-60');
    setStock($collar, 160);
    splitInto($collar, 8);
    DB::table('inventory')->where('variant_id', $collar->id)->update(['on_hand' => 1]);

    expect(fn () => reserveFor($collar, 9))->toThrow(DomainException::class);
    expect(Inventory::totals($collar->id)->reserved)->toBe(0)
        ->and(DB::table('inventory_reservations')->count())->toBe(0);
});

it('別人正在用的桶直接跳過（SKIP LOCKED），不排隊；平衡排程遇到也讓路', function () {
    $collar = variant('DCS-CAL-60');
    setStock($collar, 200);
    splitInto($collar, 2);

    // 另一條連線鎖住桶 0（模擬另一個客人正在結帳）
    config(['database.connections.other' => config('database.connections.mysql')]);
    $other = DB::connection('other');
    $other->beginTransaction();
    $other->select('SELECT * FROM inventory WHERE variant_id = ? AND bucket_no = 0 FOR UPDATE', [$collar->id]);

    DB::statement('SET SESSION innodb_lock_wait_timeout = 2');
    $started = microtime(true);
    $order = reserveFor($collar, 1);
    $waited = microtime(true) - $started;

    // 桶 1 被拿光、桶 0 被鎖：平衡排程要從桶 0 搬過來，拿不到鎖 → 讓路，不等
    DB::table('inventory')->where('variant_id', $collar->id)->where('bucket_no', 1)->update(['on_hand' => 1]);
    $round = $this->buckets->converge($collar->id);
    $other->rollBack();

    expect(DB::table('inventory_reservations')->where('order_id', $order)->value('bucket_no'))->toBe(1)
        ->and($waited)->toBeLessThan(1.0)
        ->and($round['yielded'])->toBe(1);
});

it('併桶：想要 1 桶 → 可賣的搬回桶 0；還有預留的桶等訂單處理完才刪', function () {
    $collar = variant('DCS-CAL-60');
    setStock($collar, 800);
    splitInto($collar, 8);
    $order = reserveFor($collar, 2);
    $bucket = DB::table('inventory_reservations')->where('order_id', $order)->value('bucket_no');

    splitInto($collar, 1);
    $left = bucketsOf($collar);
    expect(Inventory::totals($collar->id))->on_hand->toBe(800)->reserved->toBe(2)
        ->and($left)->toHaveCount($bucket === 0 ? 1 : 2);   // 預留的那一桶（不是桶 0 的話）先留著

    $this->inventory->commit($order);
    $this->buckets->converge($collar->id);
    expect(bucketsOf($collar))->toBe([0 => [798, 0]])
        ->and($collar->fresh()->hot_mode)->toBe('off');
});

it('平衡：某一桶被買到剩不到平均的一半 → 從最多的桶搬過去', function () {
    $collar = variant('DCS-CAL-60');
    setStock($collar, 400);
    splitInto($collar, 4);
    DB::table('inventory')->where('variant_id', $collar->id)->where('bucket_no', 2)->update(['on_hand' => 10]);   // 100 → 10

    $this->buckets->converge($collar->id);

    $available = collect(bucketsOf($collar))->map(fn ($b) => $b[0] - $b[1]);
    expect($available->sum())->toBe(310)
        ->and($available->min())->toBeGreaterThanOrEqual(intdiv(intdiv(310, 4), 2));
});

it('盤損從可賣最多的桶開始扣，不能扣到少於已預留', function () {
    $collar = variant('DCS-CAL-60');
    setStock($collar, 400);
    splitInto($collar, 4);
    reserveFor($collar, 5);

    $this->inventory->adjust($collar->id, -150);   // 一桶只有 100，要跨桶扣
    expect(Inventory::totals($collar->id))->on_hand->toBe(250)->reserved->toBe(5);

    expect(fn () => $this->inventory->adjust($collar->id, -246))->toThrow(DomainException::class);
    expect(Inventory::totals($collar->id)->on_hand)->toBe(250);
});

it('100 個程序同時搶分成 8 桶的 40 件：剛好 40 個成功，任何一桶都不會超賣', function () {
    config(['shop.inventory.min_per_bucket' => 1]);
    $collar = variant('DCS-CAL-60');
    setStock($collar, 40);
    splitInto($collar, 8);
    $orderIds = collect(range(1, 100))->map(fn () => pendingOrder()->id)->all();

    $results = concurrently(100, fn (int $i) => DB::transaction(
        fn () => app(InventoryService::class)->reserve($orderIds[$i], $collar->id, 1, now()->addMinutes(15)), 3
    ));

    expect(collect($results)->where('ok', true))->toHaveCount(40)
        ->and(collect($results)->where('error', 'insufficient_stock'))->toHaveCount(60)
        ->and(collect(bucketsOf($collar))->every(fn ($b) => $b[0] === 5 && $b[1] === 5))->toBeTrue()
        ->and(collect(app(InvariantChecker::class)->check())->every(fn ($r) => $r['ok']))->toBeTrue();
});
