<?php

use App\Filament\Resources\Products\Pages\ListProducts;
use App\Models\Brand;
use App\Models\LegalEntity;
use App\Models\Product;
use App\Models\User;
use Livewire\Livewire;

// 商品排序：前台目錄與後台列表都照 法人 → 品牌 → 商品

/** 在第一個法人的第一個品牌底下新增商品：id 最大，但排序要排在其他法人的商品前面 */
function newestProductOfFirstEntity(): Product
{
    $brand = Brand::where('legal_entity_id', LegalEntity::min('id'))->orderBy('id')->firstOrFail();

    return Product::create(['brand_id' => $brand->id, 'name' => '後加的商品', 'status' => 'active', 'delivery_modes' => ['direct']]);
}

/** 每個商品的 [法人, 品牌] 要依序不遞減 */
function expectOwnerOrder(array $productIds): void
{
    $owners = collect($productIds)->map(function ($id) {
        $brand = Product::find($id)->brand;

        return [$brand->legal_entity_id, $brand->id];
    })->all();
    $sorted = $owners;
    sort($sorted);

    expect($owners)->toBe($sorted);
}

it('前台目錄依 法人 → 品牌 → 商品 排序', function () {
    $product = newestProductOfFirstEntity();
    $product->variants()->create(['sku' => 'T-ORDER', 'name' => '後加的商品', 'price' => 100, 'shipping_class' => 'standard']);

    $ids = collect($this->getJson('/api/v1/catalog')->assertOk()->json('data'))->pluck('id')->all();

    expectOwnerOrder($ids);
    expect(array_search($product->id, $ids))->toBeLessThan(count($ids) - 1);
});

it('後台商品列表依 法人 → 品牌 → 商品 排序', function () {
    $this->actingAs(User::where('email', 'admin@example.test')->firstOrFail());
    newestProductOfFirstEntity();

    $ids = Livewire::test(ListProducts::class)->instance()->getTableRecords()->pluck('id')->all();

    expectOwnerOrder($ids);
});
