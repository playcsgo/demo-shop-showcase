<?php

use App\Filament\Resources\Products\Pages\EditProduct;
use App\Filament\Resources\Products\Pages\ListProducts;
use App\Models\Inventory;
use App\Models\Product;
use App\Models\ProductVariant;
use App\Models\User;
use Database\Seeders\CatalogSeeder;
use Livewire\Livewire;

// 種子商品（AIC-011）：support 的 14 個手寫商品＋保留的健康檢查

function brandOf(string $slug): string
{
    return Product::where('slug', $slug)->firstOrFail()->brand->project_code;
}

it('15 個商品、35 個 SKU；舊的種子 SKU 都不在了', function () {
    expect(Product::count())->toBe(15)
        ->and(ProductVariant::count())->toBe(35)
        ->and(ProductVariant::where('sku', 'not like', 'DCS-%')->count())->toBe(0);
});

it('狗的歸汪、貓的歸喵（貓狗共用的也歸喵）；吃的和用的分品牌', function () {
    expect(brandOf('adult-dog-can'))->toBe('SB')
        ->and(brandOf('calcium-chews'))->toBe('SB')
        ->and(brandOf('wooden-dog-house'))->toBe('AK')
        ->and(brandOf('health-check'))->toBe('AK')
        ->and(collect(['freeze-dried-raw-cat', 'fresh-meat-can', 'low-phosphorus-can', 'grain-free-kibble', 'cat-grass-kit', 'probiotics', 'joint-powder', 'fish-oil'])
            ->map(fn ($s) => brandOf($s))->unique()->all())->toBe(['BC'])
        ->and(collect(['tofu-litter', 'lick-mat', 'cat-teaser-wand'])->map(fn ($s) => brandOf($s))->unique()->all())->toBe(['MT'])
        ->and(Product::where('slug', 'tofu-litter')->first()->brand->legalEntity->code)->toBe('MIAO');
});

it('敘述、警示、規格都進資料庫', function () {
    $probiotics = Product::where('slug', 'probiotics')->first();
    $can = ProductVariant::where('sku', 'DCS-CAN-DUCK-80')->first();

    expect($probiotics->species)->toBe(['cat', 'dog'])
        ->and($probiotics->concerns)->toBe(['digestive'])
        ->and($probiotics->warnings)->toHaveCount(2)
        ->and($probiotics->description_md)->toContain('## 商品介紹')
        ->and($probiotics->feeding)->not->toBeEmpty()
        ->and($can->name)->toBe('鮮肉主食罐 鴨肉 80g')
        ->and($can->flavor)->toBe('鴨肉')
        ->and($can->net_weight_g)->toBe(80)
        ->and(Inventory::totals($can->id)->on_hand)->toBe(200);
});

it('交付方式：主食和貓砂可寄倉、訂閱；狗屋只能直送；健康檢查是預約', function () {
    $modes = fn (string $slug) => Product::where('slug', $slug)->first()->delivery_modes;

    expect($modes('fresh-meat-can'))->toBe(['direct', 'warehouse', 'subscription'])
        ->and($modes('tofu-litter'))->toBe(['direct', 'warehouse', 'subscription'])
        ->and($modes('probiotics'))->toBe(['direct', 'subscription'])
        ->and($modes('wooden-dog-house'))->toBe(['direct'])
        ->and($modes('health-check'))->toBe(['booking'])
        ->and(ProductVariant::where('sku', 'DCS-LIT-1')->first()->is_litter)->toBeTrue()
        ->and(ProductVariant::where('sku', 'DCS-SVC-HEALTH')->first()->isService())->toBeTrue();
});

it('可以重跑：敘述會更新，庫存不會被蓋掉', function () {
    $can = ProductVariant::where('sku', 'DCS-CAN-DUCK-80')->first();
    Inventory::where('variant_id', $can->id)->update(['on_hand' => 7]);   // 後台改過
    Product::where('slug', 'probiotics')->update(['name' => '被改掉的名字']);

    $this->seed(CatalogSeeder::class);

    expect(Product::count())->toBe(15)
        ->and(ProductVariant::count())->toBe(35)
        ->and(Inventory::totals($can->id)->on_hand)->toBe(7)
        ->and(Product::where('slug', 'probiotics')->value('name'))->toBe('寵物益生菌');
});

it('敘述寫了數字、缺清單、slug 和檔名不一致：種子失敗', function (string $front, string $body, string $error) {
    $dir = sys_get_temp_dir().'/catalog-'.uniqid();
    mkdir("{$dir}/products", 0777, true);
    file_put_contents("{$dir}/catalog.json", json_encode(['currency' => 'TWD', 'products' => [
        ['slug' => 'x', 'brand' => 'BC', 'delivery_modes' => ['direct'], 'feeding' => [], 'variants' => []],
    ]]));
    file_put_contents("{$dir}/products/x.md", "---\n{$front}\n---\n{$body}\n");

    expect(fn () => (new CatalogSeeder($dir))->run())->toThrow(RuntimeException::class, $error);
})->with([
    '內文有數字' => ["slug: x\nname: X\ncategory: 用品\nspecies: []\nlife_stage: []\nconcerns: []\nwarnings: []", '一包 30 g', '不能寫數字'],
    '缺 warnings' => ["slug: x\nname: X\ncategory: 用品\nspecies: []\nlife_stage: []\nconcerns: []", '介紹', 'warnings 要寫成清單'],
    'slug 不一致' => ["slug: y\nname: X\ncategory: 用品\nspecies: []\nlife_stage: []\nconcerns: []\nwarnings: []", '介紹', 'slug 要和檔名一致'],
]);

it('喵玩具品牌經理只看得到喵玩具的商品', function () {
    $this->actingAs(User::where('email', 'mt-manager@example.test')->firstOrFail());
    $mt = Product::whereHas('brand', fn ($q) => $q->where('project_code', 'MT'))->get();
    $others = Product::whereHas('brand', fn ($q) => $q->where('project_code', '!=', 'MT'))->get();

    Livewire::test(ListProducts::class)
        ->assertCanSeeTableRecords($mt)->assertCanNotSeeTableRecords($others);
});

it('後台編輯頁看得到介紹和不適用的情況', function () {
    $this->actingAs(User::where('email', 'admin@example.test')->firstOrFail());
    $probiotics = Product::where('slug', 'probiotics')->first();

    $this->get("/admin/products/{$probiotics->id}/edit")->assertOk()->assertSee('不適用的情況');
    Livewire::test(EditProduct::class, ['record' => $probiotics->id])
        ->assertFormSet(['slug' => 'probiotics', 'warnings' => $probiotics->warnings, 'species' => ['cat', 'dog']]);
});
