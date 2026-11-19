<?php

use App\Domain\Distribution\BatchReview;
use App\Domain\Distribution\BatchSubmission;
use App\Domain\DomainException;
use App\Domain\Reconciliation\InvariantChecker;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderStatus;
use App\Enums\ReservationStatus;
use App\Filament\Resources\DistributorBatches\Pages\ListDistributorBatches;
use App\Filament\Resources\DistributorBatches\Pages\ViewDistributorBatch;
use App\Models\Distributor;
use App\Models\DistributorBatch;
use App\Models\InventoryReservation;
use Carbon\CarbonImmutable;
use Database\Seeders\DistributorDemoSeeder;
use Illuminate\Support\Facades\DB;
use Livewire\Livewire;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    $this->sales = staff('sales-a@example.test');
    $this->other = staff('sales-b@example.test');
    $this->buyer = distributorUser('pacific-buyer@example.test');
    $this->shops = pacificShops();
    $this->food = product('SB-DOG-FOOD')->id;
    $this->review = app(BatchReview::class);
});

function submitStock(int $cases = 40): DistributorBatch
{
    return app(BatchSubmission::class)->submit(test()->buyer, stockInput([test()->shops['hk'] => [test()->food => $cases]]), 'k'.uniqid());
}

function submitEarlyBird(): DistributorBatch
{
    return app(BatchSubmission::class)->submit(test()->buyer, ['order_type' => 'early_bird', 'orders' => [[
        'shop_id' => test()->shops['hk'], 'requested_ship_date' => now('Asia/Taipei')->addDays(90)->toDateString(),
        'items' => [['product_id' => test()->food, 'qty_cases' => 10]],
    ]]], 'k'.uniqid());
}

/** 台灣經銷商：預付 0% */
function submitZeroPrepay(string $type = 'stock'): DistributorBatch
{
    $user = distributorUser('island-manager@example.test');
    $shop = Distributor::where('code', 'D-ISLAND')->firstOrFail()->shops()->sole();
    app(\App\Domain\Distribution\ShopItemSettings::class)->replace($shop, [test()->food], $user);
    $order = ['shop_id' => $shop->id, 'items' => [['product_id' => test()->food, 'qty_cases' => 10]]];
    if ($type === 'early_bird') {
        $order['requested_ship_date'] = now('Asia/Taipei')->addDays(90)->toDateString();
    }

    return app(BatchSubmission::class)->submit($user, ['order_type' => $type, 'orders' => [$order]], 'k'.uniqid());
}

function reservedFood(): int
{
    return (int) DB::table('inventory')->where('product_id', test()->food)->sum('reserved');
}

function stockInvariantsClean(): void
{
    expect(collect(app(InvariantChecker::class)->check())->filter(fn ($c, $n) => str_starts_with($n, '庫存'))->where('ok', false)->keys()->all())->toBe([]);
}

it('AC-28：別的業務看不到也操作不了；負責的業務和 super_admin 可以', function () {
    $batch = submitStock();

    $this->actingAs($this->other);
    Livewire::test(ListDistributorBatches::class)->assertCanNotSeeTableRecords([$batch]);
    $this->get("/admin/distributor-batches/{$batch->id}")->assertNotFound();
    expect(fn () => $this->review->approve($batch, $this->other))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(403));
    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::InReview);

    $this->flushSession();
    $this->actingAs($this->sales);
    Livewire::test(ListDistributorBatches::class)->assertCanSeeTableRecords([$batch]);

    $this->flushSession();
    $this->actingAs(staff('admin@example.test'))->get("/admin/distributor-batches/{$batch->id}")->assertOk();

    $this->flushSession();
    $this->actingAs(staff('product@example.test'))->get('/admin/distributor-batches')->assertForbidden();
});

it('AC-28：審核畫面看得到每張單、金額、MOQ 結果和警告', function () {
    $batch = submitStock(30);   // 30 箱，未達 MOQ 50；香港沒有禁令

    $this->actingAs($this->sales)->get("/admin/distributor-batches/{$batch->id}")->assertOk()
        ->assertSee($batch->orders()->first()->order_no)->assertSee('香港門市')->assertSee('USD 3,000.00')
        ->assertSee('未達')->assertSee('SB-DOG-FOOD');
});

it('AC-28：超過預計回覆日只標紅，狀態不變', function () {
    $this->travelTo(CarbonImmutable::parse('2026-11-09 10:00:00', 'Asia/Taipei'));
    $batch = submitStock();
    expect($batch->fresh()->isResponseOverdue())->toBeFalse();

    $this->travelTo(CarbonImmutable::parse('2026-11-11 23:00:00', 'Asia/Taipei'));
    expect($batch->fresh()->isResponseOverdue())->toBeFalse();

    $this->travelTo(CarbonImmutable::parse('2026-11-12 00:30:00', 'Asia/Taipei'));
    expect($batch->fresh()->isResponseOverdue())->toBeTrue()->and($batch->fresh()->status)->toBe(DistributorBatchStatus::InReview);
});

it('AC-29：沒有原因不能退回', function (string $reason) {
    $batch = submitStock();

    expect(fn () => $this->review->reject($batch, $this->sales, $reason))->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('reject_reason_required'));
    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::InReview)->and(reservedFood())->toBe(240);
})->with(['', '   ']);

it('AC-29：退回後 HELD 預留變 RELEASED，reserved 減回來；原因寫進版本', function () {
    $batch = submitStock();
    $this->review->reject($batch, $this->sales, '數量請再確認');

    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::Rejected)->and(reservedFood())->toBe(0);
    expect(InventoryReservation::where('distributor_order_id', $batch->orders()->sole()->id)->sole()->status)->toBe(ReservationStatus::Released);
    $revision = $batch->revisions()->sole();
    expect($revision->reject_reason)->toBe('數量請再確認')
        ->and($revision->rejected_by_user_id)->toBe($this->sales->id)
        ->and($revision->rejected_at)->not->toBeNull();
    stockInvariantsClean();
});

it('AC-31：預付 30%：等待付款，預留仍是 HELD', function () {
    $batch = submitStock();
    $this->review->approve($batch, $this->sales);

    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::AwaitingPayment)
        ->and($batch->fresh()->approved_at)->not->toBeNull()
        ->and($batch->fresh()->reviewed_by_user_id)->toBe($this->sales->id)
        ->and($batch->orders()->sole()->status)->toBe(DistributorOrderStatus::Pending)
        ->and(reservedFood())->toBe(240);
});

it('AC-31、AC-34：預付 0%：通過後停在待開始，業務按了才進入履行；待開始也可以取消', function () {
    $stock = submitZeroPrepay();
    $this->review->approve($stock, $this->sales);
    expect($stock->fresh()->status)->toBe(DistributorBatchStatus::AwaitingStart)
        ->and($stock->orders()->sole()->status)->toBe(DistributorOrderStatus::Pending);

    expect(fn () => $this->review->start($stock->fresh(), staff('sales-b@example.test')))->toThrow(fn (\App\Domain\DomainException $e) => expect($e->status)->toBe(403));
    $this->review->start($stock->fresh(), $this->sales);
    expect($stock->fresh()->status)->toBe(DistributorBatchStatus::Processing)
        ->and($stock->orders()->sole()->status)->toBe(DistributorOrderStatus::InProgress);
    expect(fn () => $this->review->start($stock->fresh(), $this->sales))->toThrow(fn (\App\Domain\DomainException $e) => expect($e->status)->toBe(409));

    $other = submitZeroPrepay();
    $this->review->approve($other, $this->sales);
    $this->review->cancel($other->fresh(), $this->sales);
    expect($other->fresh()->status)->toBe(DistributorBatchStatus::Cancelled);
});

it('AC-32：超過 7 天只標紅；取消後釋放預留；進入履行後不能取消', function () {
    $this->travelTo(CarbonImmutable::parse('2026-11-09 10:00:00', 'Asia/Taipei'));
    $batch = submitStock();
    $this->review->approve($batch, $this->sales);

    $this->travelTo(CarbonImmutable::parse('2026-11-16 09:00:00', 'Asia/Taipei'));
    expect($batch->fresh()->isPaymentOverdue())->toBeFalse();
    $this->travelTo(CarbonImmutable::parse('2026-11-16 11:00:00', 'Asia/Taipei'));
    expect($batch->fresh()->isPaymentOverdue())->toBeTrue()->and($batch->fresh()->status)->toBe(DistributorBatchStatus::AwaitingPayment);

    $this->review->cancel($batch, $this->sales);
    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::Cancelled)->and(reservedFood())->toBe(0);
    stockInvariantsClean();

    $paid = submitStock();
    $this->review->approve($paid, $this->sales);
    $this->review->confirmPayment($paid, $this->sales);
    expect(fn () => $this->review->cancel($paid, $this->sales))->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('batch_status_changed')->and($e->status)->toBe(409));
});

it('AC-33、AC-34：確認收款記下操作人和時間，同時進入履行', function () {
    $stock = submitStock();
    $this->review->approve($stock, $this->sales);
    $this->review->confirmPayment($stock, $this->sales);

    expect($stock->fresh()->status)->toBe(DistributorBatchStatus::Processing)
        ->and($stock->fresh()->payment_confirmed_by_user_id)->toBe($this->sales->id)
        ->and($stock->fresh()->payment_confirmed_at)->not->toBeNull()
        ->and($stock->orders()->sole()->status)->toBe(DistributorOrderStatus::InProgress);

    $early = submitEarlyBird();
    $this->review->approve($early, $this->sales);
    $this->review->confirmPayment($early, $this->sales);
    expect($early->orders()->sole()->status)->toBe(DistributorOrderStatus::InProgress);
});

it('AC-33：重複按只有第一次生效，事件只有一筆；別的業務不能按', function () {
    $batch = submitStock();
    $this->review->approve($batch, $this->sales);

    expect(fn () => $this->review->confirmPayment($batch, $this->other))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(403));
    $this->review->confirmPayment($batch, $this->sales);
    expect(fn () => $this->review->confirmPayment($batch, $this->sales))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(409));

    expect($batch->events()->where('type', 'PAYMENT_CONFIRMED')->count())->toBe(1);
});

it('兩個人同時按通過和退回：只有一個生效，預留狀態和批次一致', function () {
    $batch = submitStock();
    $salesId = $this->sales->id;

    $results = concurrently(2, function (int $i) use ($batch, $salesId) {
        $review = app(BatchReview::class);
        $b = DistributorBatch::findOrFail($batch->id);
        $u = \App\Models\User::findOrFail($salesId);
        $i === 0 ? $review->approve($b, $u) : $review->reject($b, $u, '衝突測試');
    });

    expect(collect($results)->where('ok', true))->toHaveCount(1);
    $status = $batch->fresh()->status;
    expect(reservedFood())->toBe($status === DistributorBatchStatus::Rejected ? 0 : 240);
    stockInvariantsClean();
});

it('沒有逐張審核的 API；經銷商不能審核', function () {
    $batch = submitStock();
    $token = distributorUser();

    foreach (['approve', 'reject', 'confirm-payment', 'cancel'] as $action) {
        $this->actingAs($token, 'distributor')->postJson("/api/v1/b2b/batches/{$batch->batch_no}/{$action}")->assertStatus(404);
    }
    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::InReview);
});

it('後台：通過、確認收款的按鈕；退回要填原因', function () {
    $this->actingAs($this->sales);
    $batch = submitStock();
    $page = fn (DistributorBatch $b) => Livewire::test(ViewDistributorBatch::class, ['record' => $b->id]);

    $page($batch)->assertActionVisible('approve')->assertActionHidden('confirmPayment')->callAction('approve');
    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::AwaitingPayment);

    $page($batch)->assertActionHidden('approve')->assertActionVisible('confirmPayment')
        ->callAction('confirmPayment', ['payment_code' => ''])->assertHasActionErrors(['payment_code']);
    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::AwaitingPayment);

    $page($batch)->callAction('confirmPayment', ['payment_code' => '隨便輸入']);
    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::Processing);
    $page($batch)->assertActionHidden('confirmPayment')->assertActionHidden('cancel')->assertActionHidden('reject');

    $other = submitStock();
    $page($other)->callAction('reject', ['reason' => ''])->assertHasActionErrors(['reason']);
    expect($other->fresh()->status)->toBe(DistributorBatchStatus::InReview);
    $page($other)->callAction('reject', ['reason' => '請改數量']);
    expect($other->fresh()->status)->toBe(DistributorBatchStatus::Rejected);
});
