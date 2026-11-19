<?php

use App\Domain\Distribution\BatchSubmission;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\Distribution\Money;
use App\Domain\Distribution\ShopItemSettings;
use App\Domain\DomainException;
use App\Filament\Resources\ContractTemplates\Pages\CreateContractTemplate;
use App\Filament\Resources\Distributors\Pages\EditDistributor;
use App\Filament\Resources\Distributors\Pages\ListDistributors;
use App\Filament\Resources\Products\Pages\EditProduct;
use App\Filament\Resources\Products\Pages\ListProducts;
use App\Filament\Support\ContractTermsForm;
use App\Models\ContractItem;
use App\Models\Distributor;
use App\Models\DistributorContract;
use App\Models\DistributorShop;
use App\Models\DistributorUser;
use App\Models\Ingredient;
use App\Models\Inventory;
use App\Models\Product;
use App\Models\ProductCountryRule;
use App\Models\ShopItem;
use Database\Seeders\DistributorDemoSeeder;
use Livewire\Livewire;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    $this->sales = staff('sales-a@example.test');
    $this->actingAs($this->sales);
    $this->fresh = Distributor::create(['code' => 'D-FRESH', 'name' => '新經銷商', 'currency' => 'USD', 'sales_user_id' => $this->sales->id]);
});

it('幣別：金額依幣別顯示小數，JPY、TWD 沒有小數', function () {
    expect(Money::format(1000, 'JPY'))->toBe('JPY 1,000')
        ->and(Money::format(1000, 'TWD'))->toBe('TWD 1,000')
        ->and(Money::format(1000, 'HKD'))->toBe('HKD 10.00')
        ->and(Money::format(1000, 'SGD'))->toBe('SGD 10.00')
        ->and(Money::format(1000, 'MYR'))->toBe('MYR 10.00')
        ->and(Money::format(1000, 'USD'))->toBe('USD 10.00');
});

it('幣別：新經銷商可以選 JPY；只有草稿合約還能改，有生效過的合約才鎖', function () {
    $page = fn () => Livewire::test(EditDistributor::class, ['record' => $this->fresh->getRouteKey()]);

    $page()->fillForm(['currency' => 'JPY'])->call('save')->assertHasNoFormErrors();
    expect($this->fresh->fresh()->currency)->toBe('JPY');

    app(ContractDrafts::class)->blank($this->fresh);
    $page()->assertFormFieldIsEnabled('currency');

    DistributorContract::where('distributor_id', $this->fresh->id)->update(['status' => 'active']);
    $page()->assertFormFieldIsDisabled('currency');
});

it('幣別：範本也可以選新幣別', function () {
    Livewire::test(CreateContractTemplate::class)
        ->fillForm(['name' => '日本範本', 'currency' => 'JPY', 'incoterm' => 'FOB', 'prepay_bps' => 3000, 'early_bird_discount_bps' => 300, 'min_lead_days' => 60, 'items' => []])
        ->call('create')->assertHasNoFormErrors();
});

it('設定價格：商品選單同時有 SKU 和中文名稱', function () {
    expect(ContractTermsForm::productOptions()[product('SB-DOG-FOOD')->id])->toBe('SB-DOG-FOOD 狗糧');
});

it('代碼：經銷商代碼建立後不能改，畫面鎖住，後端也擋', function () {
    Livewire::test(EditDistributor::class, ['record' => $this->fresh->getRouteKey()])->assertFormFieldIsDisabled('code');

    expect(fn () => $this->fresh->update(['code' => 'D-OTHER']))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('code_immutable'));
    expect($this->fresh->fresh()->code)->toBe('D-FRESH');
});

it('代碼：SKU 建立後不能改；其他欄位照常可改', function () {
    $v = product('SB-DOG-FOOD');
    $this->actingAs(staff('product@example.test'));
    Livewire::test(EditProduct::class, ['record' => $v->getRouteKey()])->assertFormFieldIsDisabled('sku');

    expect(fn () => $v->update(['sku' => 'CHANGED']))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('code_immutable'));

    $v->refresh()->update(['name' => '改名']);
    expect($v->fresh()->name)->toBe('改名')->and($v->fresh()->sku)->toBe('SB-DOG-FOOD');
});

it('刪除經銷商：沒有訂單時連帶刪除帳號、shop、顯示商品、合約', function () {
    $shop = $this->fresh->shops()->create(['name' => '店', 'country_code' => 'JP', 'city' => '大阪', 'address' => 'x']);
    $user = $this->fresh->users()->create(['name' => 'u', 'email' => 'fresh@example.test', 'password' => 'x']);
    ShopItem::create(['shop_id' => $shop->id, 'product_id' => product('SB-DOG-FOOD')->id]);
    $contract = app(ContractDrafts::class)->blank($this->fresh);

    Livewire::test(ListDistributors::class)->callTableAction('delete', $this->fresh);

    expect(Distributor::find($this->fresh->id))->toBeNull()
        ->and(DistributorShop::find($shop->id))->toBeNull()
        ->and(DistributorUser::find($user->id))->toBeNull()
        ->and(ShopItem::where('shop_id', $shop->id)->exists())->toBeFalse()
        ->and(DistributorContract::find($contract->id))->toBeNull();
});

it('刪除經銷商：已有訂單不能刪，什麼都不會少', function () {
    $d = Distributor::where('code', 'D-PACIFIC')->firstOrFail();
    $shop = DistributorShop::where('name', '香港門市')->firstOrFail();
    $food = product('SB-DOG-FOOD');
    app(ShopItemSettings::class)->replace($shop, [$food->id], distributorUser());
    $batch = app(BatchSubmission::class)->submit(distributorUser(), stockInput([$shop->id => [$food->id => 50]]), 'delete-1');

    Livewire::test(ListDistributors::class)->callTableAction('delete', $d)->assertNotified('這個經銷商已有訂單，不能刪除，請改成停權');

    expect(Distributor::find($d->id))->not->toBeNull()->and($batch->fresh())->not->toBeNull();
});

it('刪除經銷商：別的業務的經銷商刪不了', function () {
    expect(staff('sales-b@example.test')->can('delete', $this->fresh))->toBeFalse()
        ->and($this->sales->can('delete', $this->fresh))->toBeTrue();
});

it('刪除 SKU：沒有訂單時連帶刪除合約品項、範本品項、顯示設定、HS code、成分、庫存', function () {
    $v = Product::create(['sku' => 'NEW-SKU', 'name' => '新商品']);
    $v->ingredients()->sync([Ingredient::firstOrCreate(['name' => '示意'])->id]);
    ProductCountryRule::create(['product_id' => $v->id, 'country_code' => 'JP', 'hs_code' => '1']);
    $shop = DistributorShop::where('name', '香港門市')->firstOrFail();
    ShopItem::create(['shop_id' => $shop->id, 'product_id' => $v->id]);
    $item = DistributorContract::where('status', 'active')->firstOrFail()->items()->create(['product_id' => $v->id, 'moq_cases' => 1, 'case_size' => 1, 'case_multiple' => 1]);
    \App\Models\ContractTemplate::firstOrFail()->items()->create(['product_id' => $v->id, 'moq_cases' => 1, 'case_size' => 1, 'case_multiple' => 1, 'tiers' => []]);
    expect($v->hasOrderHistory())->toBeFalse();

    $this->actingAs(staff('product@example.test'));
    Livewire::test(ListProducts::class)->callTableAction('delete', $v);

    expect(Product::find($v->id))->toBeNull()
        ->and(ContractItem::find($item->id))->toBeNull()
        ->and(ShopItem::where('product_id', $v->id)->exists())->toBeFalse()
        ->and(ProductCountryRule::where('product_id', $v->id)->exists())->toBeFalse()
        ->and(Inventory::where('product_id', $v->id)->exists())->toBeFalse();
    expect(\Illuminate\Support\Facades\DB::table('contract_template_items')->where('product_id', $v->id)->exists())->toBeFalse()
        ->and(\Illuminate\Support\Facades\DB::table('ingredient_product')->where('product_id', $v->id)->exists())->toBeFalse();
});

it('刪除 SKU：有訂單就拒絕；就算繞過畫面，資料庫也擋得住，訂單不會被連帶刪掉', function () {
    $shop = DistributorShop::where('name', '香港門市')->firstOrFail();
    $food = product('SB-DOG-FOOD');
    app(ShopItemSettings::class)->replace($shop, [$food->id], distributorUser());
    $batch = app(BatchSubmission::class)->submit(distributorUser(), stockInput([$shop->id => [$food->id => 50]]), 'delete-2');
    expect($food->hasOrderHistory())->toBeTrue();

    $this->actingAs(staff('product@example.test'));
    Livewire::test(ListProducts::class)->callTableAction('delete', $food)->assertNotified('這個 SKU 已有訂單，不能刪除');
    expect(Product::find($food->id))->not->toBeNull();

    expect(fn () => $food->delete())->toThrow(\Illuminate\Database\QueryException::class);
    expect($batch->orders()->sole()->items()->count())->toBe(1);
});
