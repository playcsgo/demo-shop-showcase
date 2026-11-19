<?php

use App\Domain\Distribution\BatchPricer;
use App\Domain\Distribution\ContractActivator;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\Distribution\WorkingDays;
use App\Domain\DomainException;
use App\Models\Distributor;
use App\Models\DistributorBatch;
use Carbon\CarbonImmutable;
use Database\Seeders\DistributorDemoSeeder;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    $this->d = Distributor::where('code', 'D-PACIFIC')->firstOrFail();
    $this->shops = pacificShops();
    $this->food = product('SB-DOG-FOOD')->id;
    $this->bone = product('SB-DENTAL-BONE')->id;
});

function priceOf(Distributor $d, array $input): array
{
    return app(BatchPricer::class)->price($d, $input);
}

it('AC-20：40＋30＋50 合計 120 箱，每張單都用 100 箱以上的單價；總額 $10,800，預付無條件進位', function () {
    $p = priceOf($this->d, stockInput([$this->shops['hk'] => [$this->food => 40], $this->shops['sg'] => [$this->food => 30], $this->shops['mo'] => [$this->food => 50]]));

    expect(collect($p['orders'])->pluck('items.0.unit_price_minor')->all())->toBe([9000, 9000, 9000])
        ->and(collect($p['orders'])->pluck('subtotal_minor')->all())->toBe([360000, 270000, 450000])
        ->and($p['total_minor'])->toBe(1080000)
        ->and($p['prepay_bps'])->toBe(3000)
        ->and($p['prepay_minor'])->toBe(324000)
        ->and($p['orders'][0]['items'][0]['qty_units'])->toBe(240);
});

it('AC-20：剛好等於門檻和差 1 箱的邊界', function (int $cases, int $price) {
    $p = priceOf($this->d, stockInput([$this->shops['hk'] => [$this->food => $cases]]));

    expect($p['orders'][0]['items'][0]['unit_price_minor'])->toBe($price);
})->with([[49, 10000], [50, 9500], [99, 9500], [100, 9000], [1, 10000]]);

it('AC-20：只有同 SKU 才合計', function () {
    $p = priceOf($this->d, stockInput([$this->shops['hk'] => [$this->food => 60, $this->bone => 40], $this->shops['sg'] => [$this->food => 40, $this->bone => 5]]));

    $items = collect($p['orders'])->flatMap(fn ($o) => $o['items'])->groupBy('sku');
    expect($items['SB-DOG-FOOD']->pluck('unit_price_minor')->unique()->all())->toBe([9000])
        ->and($items['SB-DENTAL-BONE']->pluck('unit_price_minor')->unique()->all())->toBe([6000]);
});

it('AC-22：未達 MOQ 也算得出價錢，結果標示未達；MOQ 看整批合計', function () {
    $p = priceOf($this->d, stockInput([$this->shops['hk'] => [$this->food => 30]]));
    expect($p['moq_results'][0])->toMatchArray(['sku' => 'SB-DOG-FOOD', 'total_cases' => 30, 'moq_cases' => 50, 'met' => false])
        ->and($p['orders'][0]['items'][0]['unit_price_minor'])->toBe(10000);

    $p = priceOf($this->d, stockInput([$this->shops['hk'] => [$this->food => 30], $this->shops['sg'] => [$this->food => 20]]));
    expect($p['moq_results'][0]['met'])->toBeTrue();
});

it('AC-24：早鳥單價逐單位四捨五入後再乘數量；交期剛好是最早日可以，少 1 天不行', function () {
    $this->travelTo(CarbonImmutable::parse('2026-11-09 12:00:00', 'Asia/Taipei'));
    $input = fn (string $date) => ['order_type' => 'early_bird', 'orders' => [['shop_id' => $this->shops['hk'], 'requested_ship_date' => $date, 'items' => [['product_id' => $this->food, 'qty_cases' => 100]]]]];

    $p = priceOf($this->d, $input('2027-01-08'));   // 今天＋60 天
    expect($p['orders'][0]['items'][0]['unit_price_minor'])->toBe(8730)   // 9000 × 97%
        ->and($p['total_minor'])->toBe(873000);

    expect(fn () => priceOf($this->d, $input('2027-01-07')))->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('ship_date_too_soon'));
});

it('AC-24：今天用台北時間算；UTC 還是昨天的時候不會算錯', function () {
    $this->travelTo(CarbonImmutable::parse('2026-11-09 00:30:00', 'Asia/Taipei'));   // UTC 是 11/08 16:30

    expect(priceOf($this->d, ['order_type' => 'early_bird', 'orders' => [['shop_id' => $this->shops['hk'], 'requested_ship_date' => '2027-01-08', 'items' => [['product_id' => $this->food, 'qty_cases' => 1]]]]])['total_minor'])->toBeGreaterThan(0);
    expect(fn () => priceOf($this->d, ['order_type' => 'early_bird', 'orders' => [['shop_id' => $this->shops['hk'], 'requested_ship_date' => '2027-01-07', 'items' => [['product_id' => $this->food, 'qty_cases' => 1]]]]]))
        ->toThrow(DomainException::class);
});

it('AC-24：早鳥沒有交期：不能送', function () {
    expect(fn () => priceOf($this->d, ['order_type' => 'early_bird', 'orders' => [['shop_id' => $this->shops['hk'], 'items' => [['product_id' => $this->food, 'qty_cases' => 1]]]]]))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('ship_date_required'));
});

it('AC-21：箱數不是倍數：錯誤訊息指出是哪個 shop 和 SKU', function () {
    $vitamin = product('SB-VITAMIN')->id;   // 2 箱的倍數
    app(\App\Domain\Distribution\ShopItemSettings::class)->replace(\App\Models\DistributorShop::findOrFail($this->shops['hk']), [$vitamin], distributorUser());

    expect(fn () => priceOf($this->d, stockInput([$this->shops['hk'] => [$vitamin => 3]])))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('invalid_case_multiple')
            ->and($e->getMessage())->toContain('香港門市')->toContain('SB-VITAMIN'));
});

it('AC-18：同一個 shop 不能重複；同一張單同 SKU 不能重複', function () {
    $item = ['product_id' => $this->food, 'qty_cases' => 1];
    expect(fn () => priceOf($this->d, ['order_type' => 'stock', 'orders' => [['shop_id' => $this->shops['hk'], 'items' => [$item]], ['shop_id' => $this->shops['hk'], 'items' => [$item]]]]))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('duplicate_shop'));
    expect(fn () => priceOf($this->d, ['order_type' => 'stock', 'orders' => [['shop_id' => $this->shops['hk'], 'items' => [$item, $item]]]]))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('duplicate_item'));
});

it('AC-19：沒顯示的商品、合約沒允許的商品：422；別家的 shop：404', function () {
    expect(fn () => priceOf($this->d, stockInput([$this->shops['hk'] => [product('AK-PLUSH')->id => 1]])))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('item_not_available')->and($e->status)->toBe(422));
    expect(fn () => priceOf($this->d, stockInput([$this->shops['hk'] => [product('BC-TEASER')->id => 1]])))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('item_not_available'));

    $other = \App\Models\DistributorShop::where('name', '大阪門市')->value('id');
    expect(fn () => priceOf($this->d, stockInput([$other => [$this->food => 1]])))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('shop_not_found')->and($e->status)->toBe(404));
});

it('AC-25：有禁令、缺 HS code 也算得出來，警告標出 shop 和內容', function () {
    $vitamin = product('SB-VITAMIN')->id;
    app(\App\Domain\Distribution\ShopItemSettings::class)->replace(\App\Models\DistributorShop::findOrFail($this->shops['sg']), [$vitamin, $this->bone], distributorUser());

    $w = collect(priceOf($this->d, stockInput([$this->shops['sg'] => [$vitamin => 2, $this->bone => 1]]))['warnings']);

    expect($w->firstWhere('sku', 'SB-VITAMIN'))->toMatchArray(['banned' => true, 'country' => 'SG', 'shop_name' => '新加坡門市'])
        ->and($w->firstWhere('sku', 'SB-DENTAL-BONE'))->toMatchArray(['banned' => false, 'missing_hs_code' => true]);
});

it('沒有 active 合約：409', function () {
    $d = Distributor::create(['code' => 'D-NONE', 'name' => 'x', 'currency' => 'USD', 'sales_user_id' => staff('sales-a@example.test')->id]);
    $shop = $d->shops()->create(['name' => 'x', 'country_code' => 'HK', 'city' => 'x', 'address' => 'x']);

    expect(fn () => priceOf($d, stockInput([$shop->id => [$this->food => 1]])))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('no_active_contract')->and($e->status)->toBe(409));
});

it('現貨庫存不足：預覽會指出 SKU，不透露數量；不會寫入資料', function () {
    DB::table('inventory')->where('product_id', $this->food)->update(['on_hand' => 10]);

    $p = priceOf($this->d, stockInput([$this->shops['hk'] => [$this->food => 40]]));

    expect($p['stock_shortages'])->toBe(['SB-DOG-FOOD'])
        ->and(DistributorBatch::count())->toBe(0)
        ->and((int) DB::table('inventory')->where('product_id', $this->food)->value('reserved'))->toBe(0);
});

it('WorkingDays：只跳過週末', function (string $from, string $expected) {
    expect(WorkingDays::add(CarbonImmutable::parse($from), 2)->toDateString())->toBe($expected);
})->with([
    '週一' => ['2026-11-09', '2026-11-11'],
    '週四' => ['2026-11-12', '2026-11-16'],
    '週五' => ['2026-11-13', '2026-11-17'],
    '週六' => ['2026-11-14', '2026-11-17'],
    '週日' => ['2026-11-15', '2026-11-17'],
]);

it('AC-8：合約重談後，新的計價用新版', function () {
    $drafts = app(ContractDrafts::class);
    $draft = $drafts->copyOfActive($this->d);
    $terms = $draft->toTerms();
    foreach ($terms['items'] as &$item) {
        foreach ($item['tiers'] as &$tier) {
            $tier['unit_price_minor'] += 100;
        }
    }
    unset($item, $tier);
    $drafts->save($draft, $terms);
    $activator = app(ContractActivator::class);
    $activator->activate($draft->fresh(), staff('sales-a@example.test'));

    expect(priceOf($this->d, stockInput([$this->shops['hk'] => [$this->food => 1]]))['orders'][0]['items'][0]['unit_price_minor'])->toBe(10100);
});
