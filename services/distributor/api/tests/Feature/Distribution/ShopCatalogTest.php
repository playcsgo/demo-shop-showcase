<?php

use App\Domain\Distribution\ContractActivator;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\Distribution\CountryRuleService;
use App\Domain\Distribution\ShopCatalog;
use App\Domain\Distribution\ShopItemSettings;
use App\Domain\DomainException;
use App\Filament\Resources\Distributors\Pages\EditDistributor;
use App\Filament\Resources\Distributors\RelationManagers\ShopsRelationManager;
use App\Models\Distributor;
use App\Models\DistributorShop;
use App\Models\ShopItem;
use Database\Seeders\DistributorDemoSeeder;
use Filament\Actions\Testing\TestAction;
use Livewire\Livewire;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    $this->sales = staff('sales-a@example.test');
    $this->d = Distributor::where('code', 'D-PACIFIC')->firstOrFail();
    $this->hk = DistributorShop::where('name', '香港門市')->firstOrFail();
    $this->sg = DistributorShop::where('name', '新加坡門市')->firstOrFail();
    ShopItem::query()->delete();   // 種子資料的勾選清掉，測試從空的開始
    $this->food = product('SB-DOG-FOOD')->id;
    $this->bone = product('SB-DENTAL-BONE')->id;
    $this->vitamin = product('SB-VITAMIN')->id;   // 種子資料：新加坡禁保健成分
    $this->notInContract = product('BC-TEASER')->id;
    $this->manager = distributorUser('pacific-manager@example.test');
});

function catalogSkus(DistributorShop $shop): array
{
    return collect(app(ShopCatalog::class)->forShop($shop))->pluck('sku')->sort()->values()->all();
}

/** 重談：複製現行合約，改品項後生效 */
function renegotiate(Distributor $d, callable $change, $by): void
{
    $drafts = app(ContractDrafts::class);
    $draft = $drafts->copyOfActive($d);
    $terms = $draft->toTerms();
    $terms['items'] = array_values($change($terms['items']));
    $drafts->save($draft, $terms);
    $activator = app(ContractActivator::class);
    $activator->activate($draft->fresh(), $by);
}

it('AC-14：合約允許且勾選才顯示；沒勾的不顯示；合約沒有的就算有設定也不顯示', function () {
    ShopItem::create(['shop_id' => $this->hk->id, 'product_id' => $this->food]);
    ShopItem::create(['shop_id' => $this->hk->id, 'product_id' => $this->notInContract]);

    expect(catalogSkus($this->hk))->toBe(['SB-DOG-FOOD']);
});

it('AC-14：有禁令的商品照樣顯示，目錄不帶警告；組合結果附上階梯和箱規', function () {
    app(ShopItemSettings::class)->replace($this->sg, [$this->vitamin], $this->manager);

    $item = collect(app(ShopCatalog::class)->forShop($this->sg))->sole();

    expect($item['sku'])->toBe('SB-VITAMIN')
        ->and($item)->not->toHaveKey('warnings')
        ->and($item['case_size'])->toBe(24)
        ->and($item['case_multiple'])->toBe(2)
        ->and($item['moq_cases'])->toBe(20)
        ->and($item['tiers'][0])->toBe(['min_cases' => 1, 'unit_price_minor' => 12000]);
});

it('AC-14：只有 active 合約算數；草稿的新品項看不到', function () {
    ShopItem::create(['shop_id' => $this->hk->id, 'product_id' => $this->notInContract]);

    $drafts = app(ContractDrafts::class);
    $draft = $drafts->copyOfActive($this->d);
    $terms = $draft->toTerms();
    $terms['items'][] = ['product_id' => $this->notInContract, 'moq_cases' => 1, 'case_size' => 1, 'case_multiple' => 1, 'tiers' => [['min_cases' => 1, 'unit_price_minor' => 100]]];
    $drafts->save($draft, $terms);

    expect(catalogSkus($this->hk))->toBe([]);
});

it('沒有 active 合約的經銷商：shop 什麼都看不到', function () {
    $d = Distributor::create(['code' => 'D-NONE', 'name' => '沒合約', 'currency' => 'USD', 'sales_user_id' => $this->sales->id]);
    $shop = $d->shops()->create(['name' => 'x', 'country_code' => 'HK', 'city' => 'x', 'address' => 'x']);

    expect(app(ShopCatalog::class)->forShop($shop))->toBe([]);
});

it('AC-15：manager 可以用 API 設定和查看；buyer 不能設定但可以看組合結果', function () {
    $token = distributorUser();
    $this->actingAs($token, 'distributor')->putJson("/api/v1/b2b/shops/{$this->hk->id}/items", ['product_ids' => [$this->food, $this->bone]])->assertOk();
    expect(catalogSkus($this->hk))->toBe(['SB-DENTAL-BONE', 'SB-DOG-FOOD']);

    $settings = $this->actingAs($token, 'distributor')->getJson("/api/v1/b2b/shops/{$this->hk->id}/item-settings")->assertOk()->json('data');
    expect(collect($settings)->firstWhere('sku', 'SB-DOG-FOOD')['selected'])->toBeTrue()
        ->and(collect($settings)->firstWhere('sku', 'AK-PLUSH')['selected'])->toBeFalse();

    $this->app['auth']->forgetGuards();
    $buyer = distributorUser('pacific-buyer@example.test');
    $this->actingAs($buyer, 'distributor')->putJson("/api/v1/b2b/shops/{$this->hk->id}/items", ['product_ids' => []])->assertForbidden();
    $this->actingAs($buyer, 'distributor')->getJson("/api/v1/b2b/shops/{$this->hk->id}/item-settings")->assertForbidden();
    $this->actingAs($buyer, 'distributor')->getJson("/api/v1/b2b/shops/{$this->hk->id}/catalog")->assertOk()->assertJsonCount(2, 'data');
});

it('AC-15：別家帳號查這個 shop：404', function () {
    $token = distributorUser('north-manager@example.test');

    $this->actingAs($token, 'distributor')->getJson("/api/v1/b2b/shops/{$this->hk->id}/catalog")->assertNotFound();
    $this->actingAs($token, 'distributor')->getJson("/api/v1/b2b/shops/{$this->hk->id}/item-settings")->assertNotFound();
    $this->actingAs($token, 'distributor')->putJson("/api/v1/b2b/shops/{$this->hk->id}/items", ['product_ids' => []])->assertNotFound();
});

it('AC-15：勾合約沒允許的 SKU：422，原本的設定不變', function () {
    ShopItem::create(['shop_id' => $this->hk->id, 'product_id' => $this->food]);

    $this->actingAs(distributorUser(), 'distributor')->putJson("/api/v1/b2b/shops/{$this->hk->id}/items", ['product_ids' => [$this->notInContract]])
        ->assertStatus(422)->assertJson(['error' => 'item_not_in_contract']);

    expect(catalogSkus($this->hk))->toBe(['SB-DOG-FOOD']);
});

it('AC-16：勾選有禁令的商品不用確認，直接存檔', function () {
    $this->actingAs(distributorUser(), 'distributor')->putJson("/api/v1/b2b/shops/{$this->sg->id}/items", ['product_ids' => [$this->vitamin]])->assertOk();

    expect(catalogSkus($this->sg))->toBe(['SB-VITAMIN']);
});

it('AC-17：新版合約拿掉 SKU 後不顯示，設定還在；再加回來就恢復', function () {
    app(ShopItemSettings::class)->replace($this->hk, [$this->food, $this->bone], $this->manager);

    $removed = null;
    renegotiate($this->d, function (array $items) use (&$removed) {
        $removed = collect($items)->firstWhere('product_id', $this->bone);

        return array_filter($items, fn ($i) => $i['product_id'] !== $this->bone);
    }, $this->sales);

    expect(catalogSkus($this->hk))->toBe(['SB-DOG-FOOD'])
        ->and(ShopItem::where('shop_id', $this->hk->id)->where('product_id', $this->bone)->exists())->toBeTrue();

    // 合約拿掉的期間，經銷商重新存設定也不會把它洗掉
    app(ShopItemSettings::class)->replace($this->hk, [$this->food], $this->manager);
    expect(ShopItem::where('shop_id', $this->hk->id)->where('product_id', $this->bone)->exists())->toBeTrue();

    renegotiate($this->d, fn (array $items) => [...$items, $removed], $this->sales);
    expect(catalogSkus($this->hk))->toBe(['SB-DENTAL-BONE', 'SB-DOG-FOOD']);
});

it('API 組合結果不含庫存數字', function () {
    app(ShopItemSettings::class)->replace($this->sg, [$this->vitamin], $this->manager);

    $res = $this->actingAs(distributorUser(), 'distributor')->getJson("/api/v1/b2b/shops/{$this->sg->id}/catalog")->assertOk();

    $res->assertJsonPath('data.0.sku', 'SB-VITAMIN');
    expect($res->getContent())->not->toContain('on_hand')->not->toContain('reserved');
});

it('AC-15：負責的業務可以在後台替 shop 設定', function () {
    $this->actingAs($this->sales);

    Livewire::test(ShopsRelationManager::class, ['ownerRecord' => $this->d, 'pageClass' => EditDistributor::class])
        ->callAction(TestAction::make('displayItems')->table($this->sg), ['product_ids' => [$this->vitamin]]);

    expect(catalogSkus($this->sg))->toBe(['SB-VITAMIN']);
});
