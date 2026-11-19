<?php

use App\Domain\Distribution\CountryRuleService;
use App\Filament\Resources\ProductHsCodes\Pages\ListProductHsCodes;
use App\Models\Distributor;
use App\Models\Product;
use App\Models\ProductCountryRule;
use App\Models\ProductCountryRuleChange;
use Database\Seeders\DistributorDemoSeeder;
use Livewire\Livewire;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    ProductCountryRule::query()->delete();
    ProductCountryRuleChange::query()->delete();
    $this->sales = staff('sales-a@example.test');
    $this->productId = product('AK-PLUSH')->id;
});

it('AC-11：新增和修改各國 HS code 都留下變更紀錄：誰、改前、改後', function () {
    $rules = app(CountryRuleService::class);

    $rules->save($this->productId, 'HK', ['hs_code' => '2309.10'], $this->sales);
    $rules->save($this->productId, 'HK', ['hs_code' => '2309.90'], staff('sales-b@example.test'));

    $changes = ProductCountryRuleChange::orderBy('id')->get();
    expect($changes)->toHaveCount(2)
        ->and($changes[0]->before)->toBeNull()
        ->and($changes[0]->after)->toBe(['hs_code' => '2309.10'])
        ->and($changes[0]->changed_by_user_id)->toBe($this->sales->id)
        ->and($changes[1]->before)->toBe(['hs_code' => '2309.10'])
        ->and($changes[1]->after)->toBe(['hs_code' => '2309.90'])
        ->and($changes[1]->created_at)->not->toBeNull();
});

it('AC-11：內容沒變就不多記一筆', function () {
    $rules = app(CountryRuleService::class);
    $rules->save($this->productId, 'HK', ['hs_code' => '2309.10'], $this->sales);
    $rules->save($this->productId, 'HK', ['hs_code' => '2309.10'], $this->sales);

    expect(ProductCountryRuleChange::count())->toBe(1);
});

it('AC-11：沒有權限的角色打不開；業務可以看', function () {
    $this->actingAs(staff('product@example.test'))->get('/admin/product-hs-codes')->assertForbidden();
    // 換帳號要清 session：AuthenticateSession 會比對密碼雜湊，種子資料的帳號雜湊不一定相同
    $this->flushSession();
    $this->actingAs($this->sales)->get('/admin/product-hs-codes')->assertOk()->assertSee('商品 HS code');
});

it('清單：預設台灣，列出所有商品；選日本就顯示日本的 HS code，沒有國家值用 SKU 預設', function () {
    $plush = product('AK-PLUSH');
    $plush->update(['hs_code' => '9503.00']);
    app(CountryRuleService::class)->save($plush->id, 'JP', ['hs_code' => '9503.0099'], $this->sales);
    $this->actingAs($this->sales);

    $all = Product::count();

    $page = Livewire::test(ListProductHsCodes::class)
        ->assertTableFilterExists('country')
        ->assertSet('tableFilters.country.value', 'TW')
        ->loadTable()
        ->assertCountTableRecords($all)
        ->assertTableColumnStateSet('effective_hs_code', '9503.00', $plush);

    $page->filterTable('country', 'JP')
        ->assertCountTableRecords($all)
        ->assertTableColumnStateSet('effective_hs_code', '9503.0099', $plush);
});

it('清單：編輯存到目前選的國家，留紀錄；還原預設會刪掉國家值', function () {
    $plush = product('AK-PLUSH');
    $plush->update(['hs_code' => '9503.00']);
    $this->actingAs($this->sales);

    $page = Livewire::test(ListProductHsCodes::class)->filterTable('country', 'JP')
        ->callTableAction('editHsCode', $plush, ['hs_code' => '9503.0099'])
        ->assertHasNoTableActionErrors();

    $rule = ProductCountryRule::where('product_id', $plush->id)->sole();
    expect($rule->country_code)->toBe('JP')->and($rule->hs_code)->toBe('9503.0099')
        ->and(ProductCountryRuleChange::sole()->changed_by_user_id)->toBe($this->sales->id);

    $page->callTableAction('resetHsCode', $plush);
    expect(ProductCountryRule::count())->toBe(0)->and(ProductCountryRuleChange::count())->toBe(2);
    $page->assertTableColumnStateSet('effective_hs_code', '9503.00', $plush);
});

it('清單：沒有國家值的列沒有還原預設', function () {
    $plush = product('AK-PLUSH');
    $this->actingAs($this->sales);

    Livewire::test(ListProductHsCodes::class)->assertTableActionHidden('resetHsCode', $plush);
});

it('種子資料可以重複執行，不會多出合約或 HS code', function () {
    $this->seed(DistributorDemoSeeder::class);
    $contracts = \App\Models\DistributorContract::count();
    $rules = ProductCountryRule::count();

    $this->seed(DistributorDemoSeeder::class);

    expect(\App\Models\DistributorContract::count())->toBe($contracts)->and(ProductCountryRule::count())->toBe($rules)
        ->and(Distributor::where('code', 'D-PACIFIC')->firstOrFail()->contracts()->where('status', 'active')->count())->toBe(1);
});

it('刪除：留下紀錄；再新增接得上歷史', function () {
    $rules = app(CountryRuleService::class);
    $rule = $rules->save($this->productId, 'HK', ['hs_code' => '2309.10'], $this->sales);

    $rules->delete($rule, $this->sales);

    $change = ProductCountryRuleChange::latest('id')->first();
    expect($change->before)->toBe(['hs_code' => '2309.10'])->and($change->after)->toBe(['hs_code' => null]);

    $again = $rules->save($this->productId, 'HK', ['hs_code' => '2309.10'], $this->sales);
    expect($again->changes()->count())->toBe(3);
});
