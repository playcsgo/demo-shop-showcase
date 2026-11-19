<?php

use App\Filament\Resources\Products\Pages\CreateProduct;
use App\Filament\Resources\Products\Pages\EditProduct;
use App\Models\Brand;
use App\Models\Product;
use App\Models\User;
use Database\Seeders\ProductImageSeeder;
use Filament\Forms\Components\Repeater;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use League\Flysystem\AwsS3V3\AwsS3V3Adapter;
use Livewire\Features\SupportFileUploads\FileUploadConfiguration;
use Livewire\Livewire;

// 商品圖片存 S3（測試用 Storage::fake('s3')，Pest.php 每個測試前都換掉），資料庫只存路徑

/** 用種子圖片當上傳的檔案（容器裡沒有 GD，不能用 UploadedFile::fake()->image()） */
function pngUpload(string $name): UploadedFile
{
    return UploadedFile::fake()->createWithContent($name, file_get_contents(database_path('seed-assets/products/DCS-DCAN-BEEF-165.png')));
}

function catalogItem(string $name): array
{
    return collect(test()->getJson('/api/v1/catalog')->assertOk()->json('data'))->firstWhere('name', $name);
}

it('後台上傳商品圖片：檔案存在 s3、資料庫只存路徑', function () {
    $this->actingAs(User::where('email', 'admin@example.test')->firstOrFail());
    $undoRepeaterFake = Repeater::fake();

    Livewire::test(CreateProduct::class)
        ->fillForm([
            'brand_id' => Brand::first()->id, 'name' => '有圖的商品', 'status' => 'active', 'delivery_modes' => ['direct'],
            'image_path' => pngUpload('dog.png'),
            'variants' => [['sku' => 'T-IMG', 'name' => '有圖的商品', 'price' => 100, 'shipping_class' => 'standard', 'stock_change' => 1, 'is_litter' => false]],
        ])
        ->call('create')
        ->assertHasNoFormErrors();

    $path = Product::where('name', '有圖的商品')->value('image_path');
    expect($path)->toStartWith('products/')->toEndWith('.png');
    Storage::disk('s3')->assertExists($path);

    expect(catalogItem('有圖的商品')['image_url'])->toBe(rtrim(config('app.url'), '/')."/media/{$path}");

    $undoRepeaterFake();
});

it('後台只收點陣圖、最大 5 MB', function () {
    $this->actingAs(User::where('email', 'admin@example.test')->firstOrFail());
    $product = Product::first();

    Livewire::test(EditProduct::class, ['record' => $product->id])
        ->fillForm(['image_path' => UploadedFile::fake()->createWithContent('evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')])
        ->call('save')
        ->assertHasFormErrors(['image_path']);

    Livewire::test(EditProduct::class, ['record' => $product->id])
        ->fillForm(['image_path' => pngUpload('huge.png')->size(6 * 1024)])
        ->call('save')
        ->assertHasFormErrors(['image_path']);
});

it('商品目錄：種子商品有圖片網址，沒有圖片的商品是 null', function () {
    $seeded = catalogItem('成犬鮮肉主食罐');
    expect($seeded['image_url'])->toStartWith(rtrim(config('app.url'), '/').'/media/products/seed/DCS-DCAN-BEEF-165-');

    Product::create(['brand_id' => Brand::first()->id, 'name' => '沒有圖的商品', 'delivery_modes' => ['direct']])
        ->variants()->create(['sku' => 'T-NOIMG', 'name' => '沒有圖的商品', 'price' => 100, 'shipping_class' => 'standard']);

    expect(catalogItem('沒有圖的商品'))->toHaveKey('image_url')
        ->and(catalogItem('沒有圖的商品')['image_url'])->toBeNull();
});

it('/media 從 S3 串流商品圖片；只開放 products/ 底下', function () {
    $path = Product::whereNotNull('image_path')->value('image_path');

    $res = $this->get("/media/{$path}")->assertOk();
    expect($res->headers->get('Content-Type'))->toBe('image/png')
        ->and($res->headers->get('Set-Cookie'))->toBeNull();   // 不開 session：才能被快取

    Storage::disk('s3')->put('livewire-tmp/secret.png', 'x');
    $this->get('/media/livewire-tmp/secret.png')->assertNotFound();
    $this->get('/media/products/../livewire-tmp/secret.png')->assertNotFound();
    $this->get('/media/products/nope.png')->assertNotFound();
});

it('種子圖片可以重複上傳：沒變就跳過、S3 上不見了會補、後台換過的圖不動', function () {
    $doghouse = Product::where('name', '陶朱隱園')->first();
    $can = Product::where('name', '成犬鮮肉主食罐')->first();
    $seedPath = $doghouse->image_path;

    Storage::disk('s3')->delete($seedPath);              // 例如 LocalStack 重啟
    $can->update(['image_path' => 'products/admin-uploaded.png']);

    $this->seed(ProductImageSeeder::class);

    expect($doghouse->fresh()->image_path)->toBe($seedPath)
        ->and($can->fresh()->image_path)->toBe('products/admin-uploaded.png');
    Storage::disk('s3')->assertExists($seedPath);
});

it('後台上傳的暫存檔放 S3（多個 Pod 共用），而且經過 core 上傳（瀏覽器連不到 LocalStack）', function () {
    // 測試時 Livewire 改用自己的暫存 disk，這裡直接檢查正式環境用的設定
    expect(config('livewire.temporary_file_upload.disk'))->toBe('livewire-tmp')
        ->and(Storage::disk('livewire-tmp')->getAdapter())->toBeInstanceOf(AwsS3V3Adapter::class)
        ->and(FileUploadConfiguration::isUsingS3())->toBeFalse();
});
