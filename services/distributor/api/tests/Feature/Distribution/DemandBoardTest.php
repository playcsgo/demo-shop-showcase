<?php

use App\Domain\Distribution\BatchReview;
use App\Domain\Distribution\BatchSubmission;
use App\Domain\Distribution\ContractActivator;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\Distribution\DemandBoard;
use App\Domain\Distribution\OrderFulfilment;
use App\Domain\Distribution\ShopItemSettings;
use App\Filament\Pages\DemandBoard as DemandBoardPage;
use App\Models\Distributor;
use App\Models\DistributorBatch;
use App\Models\DistributorOrder;
use App\Models\DistributorShop;
use Database\Seeders\DistributorDemoSeeder;
use Livewire\Livewire;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    $this->food = product('SB-DOG-FOOD')->id;
    $this->shops = pacificShops();
    $this->board = app(DemandBoard::class);
    $this->month1 = now('Asia/Taipei')->addMonthsNoOverflow(4)->format('Y-m');
    $this->month2 = now('Asia/Taipei')->addMonthsNoOverflow(5)->format('Y-m');

    // D-NORTH：同一個 SKU 但每箱 12 件；shop 也要勾選狗糧
    $north = Distributor::where('code', 'D-NORTH')->firstOrFail();
    $drafts = app(ContractDrafts::class);
    $draft = $drafts->copyOfActive($north);
    $terms = $draft->toTerms();
    foreach ($terms['items'] as &$item) {
        $item['case_size'] = 12;
    }
    unset($item);
    $drafts->save($draft, $terms);
    $activator = app(ContractActivator::class);
    $activator->activate($draft->fresh(), staff('sales-b@example.test'));
    $this->northShop = $north->shops()->sole();
    app(ShopItemSettings::class)->replace($this->northShop, [$this->food], distributorUser('north-manager@example.test'));
});

/** 早鳥單走完審核和收款，回傳批次 */
function paidEarlyBird(string $email, string $salesEmail, int $shopId, int $productId, int $cases, string $month, bool $confirm = true): DistributorBatch
{
    $batch = app(BatchSubmission::class)->submit(distributorUser($email), ['order_type' => 'early_bird', 'orders' => [[
        'shop_id' => $shopId, 'requested_ship_date' => "{$month}-15", 'items' => [['product_id' => $productId, 'qty_cases' => $cases]],
    ]]], 'k'.uniqid());
    $review = app(BatchReview::class);
    $review->approve($batch, staff($salesEmail));
    if ($confirm) {
        $review->confirmPayment($batch, staff($salesEmail));
    }

    return $batch;
}

function boardRow(string $month, int $productId): ?array
{
    return collect(app(DemandBoard::class)->rows())->first(fn ($r) => $r['ship_month'] === $month && $r['product_id'] === $productId);
}

it('AC-35：不同經銷商、不同 shop 的同 SKU 同月份合計成一列；不同每箱件數用件數合計', function () {
    paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['hk'], $this->food, 10, $this->month1);   // 60 件
    paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['sg'], $this->food, 5, $this->month1);    // 30 件
    paidEarlyBird('north-manager@example.test', 'sales-b@example.test', $this->northShop->id, $this->food, 10, $this->month1);   // 120 件

    expect(boardRow($this->month1, $this->food))->toMatchArray(['total_units' => 210, 'order_count' => 3, 'sku' => 'SB-DOG-FOOD', 'temperature_class' => 'ambient'])
        ->and(collect($this->board->rows())->where('product_id', $this->food)->where('ship_month', $this->month1))->toHaveCount(1);
});

it('AC-35：同 SKU 不同月份分成兩列', function () {
    paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['hk'], $this->food, 10, $this->month1);
    paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['hk'], $this->food, 20, $this->month2);

    expect(boardRow($this->month1, $this->food)['total_units'])->toBe(60)
        ->and(boardRow($this->month2, $this->food)['total_units'])->toBe(120);
});

it('AC-35：現貨單、等待付款、已完工的單都不算', function () {
    $batch = app(BatchSubmission::class)->submit(distributorUser('pacific-buyer@example.test'), stockInput([$this->shops['hk'] => [$this->food => 10]]), 'stock');
    app(BatchReview::class)->approve($batch, staff('sales-a@example.test'));
    app(BatchReview::class)->confirmPayment($batch, staff('sales-a@example.test'));

    paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['sg'], $this->food, 10, $this->month1, confirm: false);

    $done = paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['mo'], $this->food, 10, $this->month1);
    app(OrderFulfilment::class)->ship($done->orders()->sole(), staff('sales-a@example.test'));

    expect($this->board->rows())->toBe([]);
});

it('AC-35：明細的訂單合計和看板數字相同，看得到是哪些單', function () {
    $a = paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['hk'], $this->food, 10, $this->month1);
    paidEarlyBird('north-manager@example.test', 'sales-b@example.test', $this->northShop->id, $this->food, 10, $this->month1);

    $details = $this->board->details($this->month1, $this->food);

    expect(collect($details)->sum('qty_units'))->toBe(boardRow($this->month1, $this->food)['total_units'])
        ->and(collect($details)->pluck('order_no'))->toContain($a->orders()->sole()->order_no)
        ->and(collect($details)->pluck('distributor_name'))->toContain('太平洋寵物貿易')->toContain('北海寵物貿易')
        ->and($details[0])->toHaveKeys(['order_no', 'distributor_name', 'shop_name', 'qty_cases', 'qty_units', 'requested_ship_date']);
});

it('AC-35：CSV 內容和看板相同', function () {
    paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['hk'], $this->food, 10, $this->month1);

    $csv = app(DemandBoard::class)->csv();

    expect($csv)->toContain('出貨月份')->toContain("{$this->month1},SB-DOG-FOOD")->toContain(',60,1');
});

it('AC-35：CSV 防公式注入：開頭是 = + - @ 的欄位有跳脫', function () {
    expect(DemandBoard::csvCell('=HYPERLINK("x")'))->toBe("'=HYPERLINK(\"x\")")
        ->and(DemandBoard::csvCell('+1'))->toBe("'+1")
        ->and(DemandBoard::csvCell('-1'))->toBe("'-1")
        ->and(DemandBoard::csvCell('@x'))->toBe("'@x")
        ->and(DemandBoard::csvCell('狗糧'))->toBe('狗糧');

    // 真的走一次：商品名稱是惡意內容時，匯出的那一格有跳脫
    product('SB-DOG-FOOD')->update(['name' => '=cmd|calc']);
    paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['hk'], $this->food, 10, $this->month1);
    expect(app(DemandBoard::class)->csv())->toContain("'=cmd|calc");
});

it('AC-35：業務打得開看板、看得到數字；沒有權限的角色打不開', function () {
    paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['hk'], $this->food, 10, $this->month1);

    $this->actingAs(staff('sales-a@example.test'));
    Livewire::test(DemandBoardPage::class)->assertOk()->assertSee('SB-DOG-FOOD')->assertSee($this->month1);

    foreach (['product@example.test'] as $email) {
        $this->flushSession();
        $this->actingAs(staff($email))->get('/admin/demand-board')->assertForbidden();
    }
});

it('AC-35：後台按匯出會下載 CSV', function () {
    paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['hk'], $this->food, 10, $this->month1);

    $this->actingAs(staff('sales-a@example.test'));
    Livewire::test(DemandBoardPage::class)
        ->callAction(\Filament\Actions\Testing\TestAction::make('export')->table())
        ->assertFileDownloaded('demand-board-'.now('Asia/Taipei')->format('Ymd').'.csv');
});

it('種子資料：demo 批次可以重複執行，看板有內容', function () {
    $seeder = app(DistributorDemoSeeder::class);
    $seeder->demoBatches();
    $count = DistributorBatch::count();
    $seeder->demoBatches();

    expect(DistributorBatch::count())->toBe($count)->and(count($this->board->rows()))->toBeGreaterThan(1);
    expect(DistributorOrder::where('status', 'IN_PROGRESS')->count())->toBeGreaterThan(1);
});

it('不變式：走完完整流程後，所有 InvariantChecker 項目都是 0', function () {
    $review = app(BatchReview::class);
    $fulfil = app(OrderFulfilment::class);
    $sales = staff('sales-a@example.test');

    $stock = app(BatchSubmission::class)->submit(distributorUser('pacific-buyer@example.test'), stockInput([$this->shops['hk'] => [$this->food => 10], $this->shops['sg'] => [$this->food => 5]]), 'flow');
    $review->reject($stock, $sales, '改數量');
    app(BatchSubmission::class)->resubmit(distributorUser('pacific-buyer@example.test'), $stock, stockInput([$this->shops['hk'] => [$this->food => 12]]));
    $review->approve($stock->fresh(), $sales);
    $review->confirmPayment($stock->fresh(), $sales);
    $fulfil->ship($stock->orders()->sole(), $sales);
    $fulfil->deliver($stock->orders()->sole()->fresh(), $sales);

    $early = paidEarlyBird('pacific-buyer@example.test', 'sales-a@example.test', $this->shops['mo'], $this->food, 10, $this->month1);
    $fulfil->ship($early->orders()->sole(), $sales);

    $bad = collect(app(\App\Domain\Reconciliation\InvariantChecker::class)->check())->where('ok', false)->keys()->all();
    expect($bad)->toBe([]);
});
