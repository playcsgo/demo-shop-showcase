<?php

use App\Domain\Distribution\BatchReview;
use App\Domain\Distribution\BatchSubmission;
use App\Domain\Distribution\OrderFulfilment;
use App\Domain\DomainException;
use App\Enums\BatchFollowUp;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderStatus;
use App\Enums\ReservationStatus;
use App\Filament\Resources\DistributorBatches\Pages\ListDistributorBatches;
use App\Filament\Resources\DistributorBatches\Pages\ViewDistributorBatch;
use App\Filament\Resources\DistributorBatches\RelationManagers\OrdersRelationManager;
use App\Filament\Resources\DistributorOrders\DistributorOrderResource;
use App\Filament\Resources\DistributorOrders\Pages\ViewDistributorOrder;
use App\Models\DistributorBatch;
use App\Models\DistributorOrder;
use App\Models\DistributorOrderEtaChange;
use App\Models\InventoryReservation;
use App\Models\User;
use Database\Seeders\DistributorDemoSeeder;
use Filament\Actions\Testing\TestAction;
use Illuminate\Support\Facades\DB;
use Livewire\Livewire;
use Spatie\Permission\Models\Role;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    $this->food = product('SB-DOG-FOOD')->id;
    $this->shops = pacificShops();
    $this->buyer = distributorUser('pacific-buyer@example.test');
    $this->sales = staff('sales-a@example.test');
    $this->otherSales = staff('sales-b@example.test');
    $this->fulfil = app(OrderFulfilment::class);
});

function paidStockOrder(int $cases = 10): DistributorOrder
{
    $batch = app(BatchSubmission::class)->submit(test()->buyer, stockInput([test()->shops['hk'] => [test()->food => $cases]]), 'k'.uniqid());
    app(BatchReview::class)->approve($batch, test()->sales);
    app(BatchReview::class)->confirmPayment($batch, test()->sales);

    return $batch->orders()->sole();
}

function paidEarlyOrder(): DistributorOrder
{
    $batch = app(BatchSubmission::class)->submit(test()->buyer, ['order_type' => 'early_bird', 'orders' => [[
        'shop_id' => test()->shops['hk'], 'requested_ship_date' => now('Asia/Taipei')->addDays(90)->toDateString(),
        'items' => [['product_id' => test()->food, 'qty_cases' => 10]],
    ]]], 'k'.uniqid());
    app(BatchReview::class)->approve($batch, test()->sales);
    app(BatchReview::class)->confirmPayment($batch, test()->sales);

    return $batch->orders()->sole();
}

/** @return array{on_hand: int, reserved: int} */
function foodStock(): array
{
    $r = DB::table('inventory')->where('product_id', test()->food)->selectRaw('SUM(on_hand) oh, SUM(reserved) rs')->first();

    return ['on_hand' => (int) $r->oh, 'reserved' => (int) $r->rs];
}

function etaDate(int $days): string
{
    return now('Asia/Taipei')->addDays($days)->toDateString();
}

it('AC-34：進入履行後，早鳥和現貨的訂單都是 IN_PROGRESS，批次是 PROCESSING', function () {
    foreach ([paidEarlyOrder(), paidStockOrder()] as $order) {
        expect($order->status)->toBe(DistributorOrderStatus::InProgress)
            ->and($order->batch->status)->toBe(DistributorBatchStatus::Processing);
    }
});

it('AC-36：業務可以填和改 ETA，每次改動都留紀錄；內容沒變不多記；可以清空', function () {
    $order = paidEarlyOrder();

    $this->fulfil->setEta($order, etaDate(30), $this->sales);
    $this->fulfil->setEta($order->fresh(), etaDate(30), $this->sales);
    $this->fulfil->setEta($order->fresh(), etaDate(40), $this->sales);
    expect($order->fresh()->eta_date->toDateString())->toBe(etaDate(40));

    $changes = DistributorOrderEtaChange::where('order_id', $order->id)->orderBy('id')->get();
    expect($changes)->toHaveCount(2)
        ->and($changes[0]->before_date)->toBeNull()
        ->and($changes[1]->before_date->toDateString())->toBe(etaDate(30))
        ->and($changes[1]->after_date->toDateString())->toBe(etaDate(40))
        ->and($changes[1]->changed_by_user_id)->toBe($this->sales->id);

    $this->fulfil->setEta($order->fresh(), null, $this->sales);
    expect($order->fresh()->eta_date)->toBeNull();
});

it('AC-36：出貨後還能改 ETA；已送達鎖住；還沒進入履行不能填；別的業務不能改', function () {
    $order = paidStockOrder();
    expect(fn () => $this->fulfil->setEta($order, etaDate(5), $this->otherSales))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(403));

    $this->fulfil->ship($order, $this->sales);
    $this->fulfil->setEta($order->fresh(), etaDate(10), $this->sales);
    expect($order->fresh()->eta_date->toDateString())->toBe(etaDate(10));

    $this->fulfil->deliver($order->fresh(), $this->sales);
    expect(fn () => $this->fulfil->setEta($order->fresh(), etaDate(20), $this->sales))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(409));

    $pending = app(BatchSubmission::class)->submit($this->buyer, stockInput([$this->shops['sg'] => [$this->food => 1]]), 'not-started')->orders()->sole();
    expect(fn () => $this->fulfil->setEta($pending, etaDate(5), $this->sales))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(409));
});

it('AC-37：現貨出貨後 HELD 變 COMMITTED，on_hand 和 reserved 都減少；不用先填 ETA；重複按不會扣兩次', function () {
    $before = foodStock();
    $order = paidStockOrder(10);   // 60 件
    expect(foodStock())->toBe(['on_hand' => $before['on_hand'], 'reserved' => $before['reserved'] + 60])
        ->and($order->eta_date)->toBeNull();

    $this->fulfil->ship($order, $this->sales);

    expect($order->fresh()->status)->toBe(DistributorOrderStatus::Shipped)
        ->and($order->fresh()->shipped_at)->not->toBeNull()
        ->and($order->fresh()->shipped_by_user_id)->toBe($this->sales->id)
        ->and(foodStock())->toBe(['on_hand' => $before['on_hand'] - 60, 'reserved' => $before['reserved']])
        ->and(InventoryReservation::where('distributor_order_id', $order->id)->sole()->status)->toBe(ReservationStatus::Committed);

    expect(fn () => $this->fulfil->ship($order, $this->sales))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(409));
    expect(foodStock()['on_hand'])->toBe($before['on_hand'] - 60);
});

it('AC-37：同時按兩次出貨只扣一次', function () {
    $before = foodStock();
    $order = paidStockOrder(10);
    $orderId = $order->id;
    $userId = $this->sales->id;

    $results = concurrently(2, fn () => app(OrderFulfilment::class)->ship(DistributorOrder::findOrFail($orderId), User::findOrFail($userId)));

    expect(collect($results)->where('ok', true))->toHaveCount(1)->and(foodStock()['on_hand'])->toBe($before['on_hand'] - 60);
});

it('AC-37：早鳥出貨後 inventory 完全不變；別的業務不能按，總管理可以', function () {
    $order = paidEarlyOrder();
    $before = foodStock();

    expect(fn () => $this->fulfil->ship($order, $this->otherSales))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(403));
    $this->fulfil->ship($order, staff('admin@example.test'));

    expect(foodStock())->toBe($before)->and($order->fresh()->status)->toBe(DistributorOrderStatus::Shipped);
});

it('AC-41：只有已出貨的單能按已送達，記下誰何時；不動庫存；重複按只生效一次；別的業務不能按', function () {
    $order = paidStockOrder();
    expect(fn () => $this->fulfil->deliver($order, $this->sales))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(409));

    $this->fulfil->ship($order, $this->sales);
    $stock = foodStock();
    expect(fn () => $this->fulfil->deliver($order->fresh(), $this->otherSales))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(403));

    $this->fulfil->deliver($order->fresh(), $this->sales);
    expect($order->fresh()->status)->toBe(DistributorOrderStatus::Delivered)
        ->and($order->fresh()->delivered_at)->not->toBeNull()
        ->and($order->fresh()->delivered_by_user_id)->toBe($this->sales->id)
        ->and(foodStock())->toBe($stock);
    expect(fn () => $this->fulfil->deliver($order->fresh(), $this->sales))->toThrow(fn (DomainException $e) => expect($e->status)->toBe(409));
});

it('AC-42：所有訂單都送達，批次才變已完成', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, stockInput([$this->shops['hk'] => [$this->food => 1], $this->shops['sg'] => [$this->food => 1]]), 'two-shops');
    app(BatchReview::class)->approve($batch, $this->sales);
    app(BatchReview::class)->confirmPayment($batch, $this->sales);
    [$first, $second] = $batch->orders()->orderBy('id')->get()->all();

    foreach ([$first, $second] as $order) {
        $this->fulfil->ship($order, $this->sales);
    }
    $this->fulfil->deliver($first->fresh(), $this->sales);
    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::Processing);

    $this->fulfil->deliver($second->fresh(), $this->sales);
    expect($batch->fresh()->status)->toBe(DistributorBatchStatus::Completed);
});

it('AC-43：審核和付款階段的待處理標示', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, stockInput([$this->shops['hk'] => [$this->food => 1]]), 'follow-up');
    expect($batch->followUp())->toBe(BatchFollowUp::NeedsAction);

    app(BatchReview::class)->reject($batch, $this->sales, '改數量');
    expect($batch->fresh()->followUp())->toBe(BatchFollowUp::Waiting);

    app(BatchSubmission::class)->resubmit($this->buyer, $batch, stockInput([$this->shops['hk'] => [$this->food => 1]]));
    app(BatchReview::class)->approve($batch->fresh(), $this->sales);
    expect($batch->fresh()->followUp())->toBe(BatchFollowUp::Waiting);

    $this->travel(8)->days();
    expect($batch->fresh()->followUp())->toBe(BatchFollowUp::NeedsAction);

    app(BatchReview::class)->cancel($batch->fresh(), $this->sales);
    expect($batch->fresh()->followUp())->toBe(BatchFollowUp::Ended);
});

it('AC-43：履行階段的待處理標示依 ETA 和出貨狀態', function () {
    $order = paidStockOrder();
    $batch = fn () => $order->batch()->sole();

    expect($batch()->followUp())->toBe(BatchFollowUp::NeedsAction);   // 沒填 ETA

    $this->fulfil->setEta($order, etaDate(0), $this->sales);
    expect($batch()->followUp())->toBe(BatchFollowUp::Waiting);       // ETA 當天還不算過期

    $this->fulfil->setEta($order->fresh(), etaDate(-1), $this->sales);
    expect($batch()->followUp())->toBe(BatchFollowUp::NeedsAction);   // ETA 已過，還沒出貨

    $this->fulfil->setEta($order->fresh(), etaDate(5), $this->sales);
    $this->fulfil->ship($order->fresh(), $this->sales);
    expect($batch()->followUp())->toBe(BatchFollowUp::Waiting);       // 在路上

    $this->fulfil->setEta($order->fresh(), etaDate(-1), $this->sales);
    expect($batch()->followUp())->toBe(BatchFollowUp::NeedsAction);   // ETA 已過，還沒按已送達

    $this->fulfil->deliver($order->fresh(), $this->sales);
    expect($batch()->followUp())->toBe(BatchFollowUp::Ended);
});

it('AC-43：批次清單可以篩選待處理', function () {
    $todo = paidStockOrder()->batch()->sole();
    $waitingOrder = paidEarlyOrder();
    $this->fulfil->setEta($waitingOrder, etaDate(30), $this->sales);

    $this->actingAs($this->sales);
    Livewire::test(ListDistributorBatches::class)
        ->filterTable('follow_up', BatchFollowUp::NeedsAction->value)
        ->assertCanSeeTableRecords([$todo])->assertCanNotSeeTableRecords([$waitingOrder->batch()->sole()]);
});

it('批次頁：列出各 shop 的訂單、金額和狀態，業務直接在這裡填 ETA、出貨、送達', function () {
    $order = paidStockOrder();
    $batch = $order->batch()->sole();

    $this->actingAs($this->sales)->get("/admin/distributor-batches/{$batch->id}")->assertOk()->assertDontSee('箱 ×');

    $rm = fn () => Livewire::test(OrdersRelationManager::class, ['ownerRecord' => $batch, 'pageClass' => ViewDistributorBatch::class]);
    // 點整列（含 ETA 那格）進明細：網址要用單號，用 id 會 404
    $rm()->assertCanSeeTableRecords([$order])->assertSee('香港門市')->assertSee('待出貨')->assertSee('USD')
        ->assertSee("/admin/distributor-orders/{$order->order_no}")->assertDontSee("/admin/distributor-orders/{$order->id}\"", false)
        ->callAction(TestAction::make('setEta')->table($order), ['eta_date' => etaDate(20)]);
    expect($order->fresh()->eta_date->toDateString())->toBe(etaDate(20));

    $rm()->assertActionHidden(TestAction::make('deliver')->table($order->fresh()))
        ->callAction(TestAction::make('ship')->table($order->fresh()));
    expect($order->fresh()->status)->toBe(DistributorOrderStatus::Shipped);

    $rm()->assertActionHidden(TestAction::make('ship')->table($order->fresh()))
        ->callAction(TestAction::make('deliver')->table($order->fresh()));
    expect($order->fresh()->status)->toBe(DistributorOrderStatus::Delivered);

    $rm()->assertActionHidden(TestAction::make('setEta')->table($order->fresh()))->assertSee('已送達');
});

it('訂單明細：看得到品項和金額，也可以操作；送達後還打得開', function () {
    $order = paidStockOrder();
    $url = "/admin/distributor-orders/{$order->order_no}";

    $this->actingAs($this->sales)->get($url)->assertOk()
        ->assertSee('香港門市')->assertSee('SB-DOG-FOOD')->assertSee('狗糧')->assertSee('10 箱')->assertSee('60 件')->assertSee('USD');

    Livewire::test(ViewDistributorOrder::class, ['record' => $order->order_no])
        ->assertActionVisible('ship')->callAction('ship');
    expect($order->fresh()->status)->toBe(DistributorOrderStatus::Shipped);
    Livewire::test(ViewDistributorOrder::class, ['record' => $order->order_no])->callAction('deliver');

    $this->get($url)->assertOk()->assertSee('已送達');
});

it('訂單明細：別的業務和沒權限的角色打不開；側邊欄不列訂單', function () {
    $order = paidStockOrder();
    $url = "/admin/distributor-orders/{$order->order_no}";

    foreach ([$this->otherSales, staff('product@example.test')] as $user) {
        $this->flushSession();
        $this->actingAs($user)->get($url)->assertForbidden();
    }
    $this->flushSession();
    $this->actingAs($this->sales);
    expect(DistributorOrderResource::shouldRegisterNavigation())->toBeFalse();
});

it('沒有生管和倉庫的角色和帳號', function () {
    expect(Role::whereIn('name', ['production_planner', 'warehouse_staff'])->exists())->toBeFalse()
        ->and(User::whereIn('email', ['production@example.test', 'warehouse@example.test'])->exists())->toBeFalse();
});

it('AC-38：時間軸的事件順序正確，含退回和重送；看不到內部人員的資料', function () {
    $review = app(BatchReview::class);
    $submission = app(BatchSubmission::class);
    $input = stockInput([$this->shops['hk'] => [$this->food => 10]]);

    $batch = $submission->submit($this->buyer, $input, 'timeline');
    $review->reject($batch, $this->sales, '數量請再確認');
    $submission->resubmit($this->buyer, $batch, $input);
    $review->approve($batch->fresh(), $this->sales);
    $review->confirmPayment($batch->fresh(), $this->sales);
    $order = $batch->orders()->sole();
    $this->fulfil->setEta($order, etaDate(30), $this->sales);
    $this->fulfil->setEta($order->fresh(), etaDate(40), $this->sales);
    $this->fulfil->ship($order->fresh(), $this->sales);

    $res = $this->actingAs(distributorUser('pacific-buyer@example.test'), 'distributor')->getJson("/api/v1/b2b/orders/{$order->order_no}")->assertOk();

    expect(collect($res->json('timeline'))->pluck('type')->all())->toBe(['SUBMITTED', 'REJECTED', 'RESUBMITTED', 'APPROVED', 'PAYMENT_CONFIRMED', 'ORDER_SHIPPED'])
        ->and(collect($res->json('timeline'))->firstWhere('type', 'REJECTED')['note'])->toBe('數量請再確認')
        ->and($res->json('status'))->toBe('SHIPPED')
        ->and($res->json('eta_date'))->toBe(etaDate(40))
        ->and($res->json('shipped_at'))->not->toBeNull();
    expect($res->json('timeline.0'))->toHaveKeys(['type', 'label', 'occurred_at', 'note']);
    $body = $res->getContent();
    expect($body)->not->toContain('actor')->not->toContain('業務 A')->not->toContain('before_date')->not->toContain('_by_user_id');
});

it('AC-38：一批多張單：只看得到這張單和整批的事件；查別家的訂單回 404', function () {
    $batch = app(BatchSubmission::class)->submit($this->buyer, stockInput([$this->shops['hk'] => [$this->food => 1], $this->shops['sg'] => [$this->food => 1]]), 'multi');
    app(BatchReview::class)->approve($batch, $this->sales);
    app(BatchReview::class)->confirmPayment($batch, $this->sales);
    $hk = $batch->orders()->where('shop_id', $this->shops['hk'])->sole();
    $sg = $batch->orders()->where('shop_id', $this->shops['sg'])->sole();
    $this->fulfil->ship($hk, $this->sales);

    $token = distributorUser('pacific-buyer@example.test');
    expect(collect($this->actingAs($token, 'distributor')->getJson("/api/v1/b2b/orders/{$hk->order_no}")->json('timeline'))->pluck('type'))->toContain('ORDER_SHIPPED');
    expect(collect($this->actingAs($token, 'distributor')->getJson("/api/v1/b2b/orders/{$sg->order_no}")->json('timeline'))->pluck('type'))->not->toContain('ORDER_SHIPPED');

    $this->actingAs($token, 'distributor')->getJson('/api/v1/b2b/orders')->assertOk()->assertJsonCount(2, 'data');

    $this->app['auth']->forgetGuards();
    $north = distributorUser('north-manager@example.test');
    $this->actingAs($north, 'distributor')->getJson("/api/v1/b2b/orders/{$hk->order_no}")->assertNotFound();
    $this->actingAs($north, 'distributor')->getJson('/api/v1/b2b/orders')->assertOk()->assertJsonCount(0, 'data');
});
