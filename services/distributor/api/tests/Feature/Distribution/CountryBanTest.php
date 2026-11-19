<?php

use App\Domain\Distribution\BatchSubmission;
use App\Domain\Distribution\ContractActivator;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\Distribution\CountryBanService;
use App\Domain\Distribution\CountryRuleService;
use App\Domain\Distribution\ShopCatalog;
use App\Domain\Distribution\ShopItemSettings;
use App\Enums\ContractStatus;
use App\Filament\Resources\CountryBans\Pages\ManageCountryBans;
use App\Models\CountryIngredientBan;
use App\Models\CountryIngredientBanChange;
use App\Models\Distributor;
use App\Models\DistributorShop;
use App\Models\Ingredient;
use App\Models\Product;
use App\Models\ProductCountryRule;
use Database\Seeders\DistributorDemoSeeder;
use Livewire\Livewire;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    CountryIngredientBan::query()->delete();
    ProductCountryRule::query()->delete();
    $this->sales = staff('sales-a@example.test');
    $this->d = Distributor::where('code', 'D-PACIFIC')->firstOrFail();
    $this->buyer = distributorUser();
    $this->hk = DistributorShop::where('name', '香港門市')->firstOrFail();
    $this->sg = DistributorShop::where('name', '新加坡門市')->firstOrFail();
    $this->pork = Ingredient::firstOrCreate(['name' => '示意豬肉']);
    $this->food = product('SB-DOG-FOOD');
    $this->food->ingredients()->sync([$this->pork->id]);
    app(ShopItemSettings::class)->replace($this->sg, [$this->food->id], $this->buyer);
    app(ShopItemSettings::class)->replace($this->hk, [$this->food->id], $this->buyer);
});

/** 這個 shop 的訂單掃描結果 */
function scan(DistributorShop $shop, Product $product): ?array
{
    $priced = app(\App\Domain\Distribution\BatchPricer::class)->price(test()->d, stockInput([$shop->id => [$product->id => 50]]));

    return collect($priced['warnings'])->firstWhere('sku', $product->sku);
}

it('AC-12：SKU 的成分在該國被禁止：跳警告，列出成分和原因', function () {
    app(CountryBanService::class)->save('SG', $this->pork->id, '示意：宗教規範', $this->sales);

    expect(scan($this->sg, $this->food))->toMatchArray([
        'banned' => true,
        'banned_ingredients' => [['name' => '示意豬肉', 'reason' => '示意：宗教規範']],
    ]);
});

it('AC-12：別國的禁令、沒含這個成分的 SKU 都不跳', function () {
    app(CountryBanService::class)->save('SG', $this->pork->id, null, $this->sales);
    $this->food->update(['hs_code' => '2309.10']);

    expect(scan($this->hk, $this->food))->toBeNull();

    $this->food->ingredients()->sync([Ingredient::firstOrCreate(['name' => '示意雞肉'])->id]);
    expect(scan($this->sg, $this->food))->toBeNull();
});

it('AC-12：有禁令也送得出去；警告存到批次，規則之後改動不影響已存的內容', function () {
    $ban = app(CountryBanService::class)->save('SG', $this->pork->id, '示意', $this->sales);

    $batch = app(BatchSubmission::class)->submit($this->buyer, stockInput([$this->sg->id => [$this->food->id => 50]]), 'ban-1');
    app(CountryBanService::class)->delete($ban, $this->sales);

    expect(collect($batch->fresh()->warnings)->firstWhere('sku', 'SB-DOG-FOOD')['banned_ingredients'][0]['name'])->toBe('示意豬肉');
});

it('AC-12：合約生效和 shop 選商品不再要求確認，目錄也不帶警告', function () {
    app(CountryBanService::class)->save('SG', $this->pork->id, '示意', $this->sales);

    $draft = app(ContractDrafts::class)->copyOfActive($this->d);
    app(ContractActivator::class)->activate($draft, $this->sales);
    expect($draft->fresh()->status)->toBe(ContractStatus::Active);

    app(ShopItemSettings::class)->replace($this->sg, [$this->food->id], $this->buyer);
    expect(collect(app(ShopCatalog::class)->forShop($this->sg))->sole())->not->toHaveKey('warnings');
});

it('AC-13：沒填成分提醒無法檢查；標記不含成分就不提醒', function () {
    $this->food->update(['hs_code' => '2309.10']);
    $this->food->ingredients()->detach();

    expect(scan($this->sg, $this->food))->toMatchArray(['banned' => false, 'missing_ingredients' => true]);

    $this->food->update(['no_ingredients' => true]);
    expect(scan($this->sg, $this->food))->toBeNull();
});

it('AC-13：HS code 用國家值，沒有才用 SKU 預設；都沒有才提醒缺', function () {
    $this->food->update(['hs_code' => null]);
    expect(scan($this->sg, $this->food))->toMatchArray(['missing_hs_code' => true, 'hs_code' => null]);

    $this->food->update(['hs_code' => '2309.10']);
    expect(scan($this->sg, $this->food))->toBeNull();

    $priced = fn () => app(\App\Domain\Distribution\BatchPricer::class)->price($this->d, stockInput([$this->sg->id => [$this->food->id => 50]]))['orders'][0]['items'][0];
    expect($priced()['hs_code'])->toBe('2309.10');

    app(CountryRuleService::class)->save($this->food->id, 'SG', ['hs_code' => '2309.1010'], $this->sales);
    expect($priced()['hs_code'])->toBe('2309.1010');
});

it('AC-25：訂單品項存當時的 HS code，之後改碼不影響', function () {
    $this->food->update(['hs_code' => '2309.10']);
    $batch = app(BatchSubmission::class)->submit($this->buyer, stockInput([$this->sg->id => [$this->food->id => 50]]), 'hs-1');

    $this->food->update(['hs_code' => '9999.99']);

    expect($batch->orders()->sole()->items()->sole()->hs_code)->toBe('2309.10');
});

it('AC-28：審核畫面看得到禁令和參考 HS code', function () {
    $this->food->update(['hs_code' => '2309.10']);
    app(CountryBanService::class)->save('SG', $this->pork->id, '示意原因', $this->sales);
    $batch = app(BatchSubmission::class)->submit($this->buyer, stockInput([$this->sg->id => [$this->food->id => 50]]), 'view-1');

    $this->actingAs($this->sales)->get("/admin/distributor-batches/{$batch->id}")->assertOk()
        ->assertSee('含示意豬肉')->assertSee('示意原因');
    $this->get('/admin/distributor-orders/'.$batch->orders()->sole()->order_no)->assertOk()
        ->assertSee('2309.10')->assertSee('以貨代為準');
});

it('AC-11：新增、修改、刪除禁令都留紀錄；內容沒變不多記', function () {
    $bans = app(CountryBanService::class);

    $ban = $bans->save('SG', $this->pork->id, '示意', $this->sales);
    $bans->save('SG', $this->pork->id, '示意', $this->sales);
    $bans->save('SG', $this->pork->id, '改過', staff('sales-b@example.test'));
    $bans->delete($ban->fresh(), $this->sales);

    $changes = CountryIngredientBanChange::where('country_code', 'SG')->where('ingredient_id', $this->pork->id)->orderBy('id')->get();
    expect($changes)->toHaveCount(3)
        ->and($changes[0]->before)->toBeNull()
        ->and($changes[1]->before)->toBe(['reason' => '示意'])
        ->and($changes[1]->after)->toBe(['reason' => '改過'])
        ->and($changes[2]->after)->toBeNull()
        ->and($changes[2]->changed_by_user_id)->toBe($this->sales->id);
    expect(CountryIngredientBan::count())->toBe(0);
});

it('AC-11：後台可以新增和刪除，刪除就是解除；沒權限的角色打不開', function () {
    $this->actingAs(staff('product@example.test'))->get('/admin/country-bans')->assertForbidden();

    $this->flushSession();
    $this->actingAs($this->sales);
    $this->get('/admin/country-bans')->assertOk();

    Livewire::test(ManageCountryBans::class)
        ->callAction('create', ['country_code' => 'SG', 'ingredient_id' => $this->pork->id, 'reason' => '示意'])
        ->assertHasNoActionErrors();
    $ban = CountryIngredientBan::sole();
    expect(scan($this->sg, $this->food)['banned'])->toBeTrue();

    Livewire::test(ManageCountryBans::class)->callTableAction('delete', $ban);
    expect(CountryIngredientBan::count())->toBe(0)
        ->and(CountryIngredientBanChange::latest('id')->first()->changed_by_user_id)->toBe($this->sales->id);
});

it('成分清單：有人用的成分刪不掉，名稱不重複', function () {
    expect($this->pork->isInUse())->toBeTrue();
    expect(Ingredient::firstOrCreate(['name' => '示意沒人用'])->isInUse())->toBeFalse();
    expect(fn () => Ingredient::create(['name' => '示意豬肉']))->toThrow(\Illuminate\Database\QueryException::class);
});

it('種子資料可以重複執行：成分、禁令不會變多', function () {
    $this->seed(DistributorDemoSeeder::class);
    $counts = [Ingredient::count(), CountryIngredientBan::count()];

    $this->seed(DistributorDemoSeeder::class);

    expect([Ingredient::count(), CountryIngredientBan::count()])->toBe($counts);
});
