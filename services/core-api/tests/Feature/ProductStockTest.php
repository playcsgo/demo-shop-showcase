<?php

use App\Domain\Catalog\InventoryService;
use App\Domain\DomainException;
use App\Filament\Resources\Products\Pages\CreateProduct;
use App\Filament\Resources\Products\Pages\EditProduct;
use App\Models\Brand;
use App\Models\Inventory;
use App\Models\Product;
use App\Models\User;
use Filament\Forms\Components\Repeater;
use Illuminate\Support\Facades\DB;
use Livewire\Livewire;

beforeEach(fn () => $this->inventory = app(InventoryService::class));

it('新增實體商品的規格會自動有一列庫存（0）；服務沒有庫存', function () {
    $product = Product::create(['brand_id' => Brand::first()->id, 'name' => '測試商品', 'delivery_modes' => ['direct']]);
    $goods = $product->variants()->create(['sku' => 'T-GOODS', 'name' => '實體', 'price' => 100, 'shipping_class' => 'standard']);
    $service = $product->variants()->create(['sku' => 'T-SERVICE', 'name' => '服務', 'price' => 100, 'shipping_class' => 'service']);

    expect(Inventory::totals($goods->id)?->on_hand)->toBe(0)
        ->and(Inventory::totals($service->id))->toBeNull();
});

it('調整庫存用增減；不能少於已被預留的數量', function () {
    $doghouse = variant('DCS-DH-M');   // 庫存 6
    DB::transaction(fn () => $this->inventory->reserve(pendingOrder()->id, $doghouse->id, 3, now()->addMinutes(15)));

    $this->inventory->adjust($doghouse->id, 10);
    expect(Inventory::totals($doghouse->id)->on_hand)->toBe(16);

    $this->inventory->adjust($doghouse->id, -13);   // 16 − 13 = 3，剛好等於已預留
    expect(Inventory::totals($doghouse->id)->on_hand)->toBe(3);

    expect(fn () => $this->inventory->adjust($doghouse->id, -1))->toThrow(DomainException::class);
    expect(Inventory::totals($doghouse->id)->on_hand)->toBe(3);
});

it('後台上架商品時填庫存；編輯時增減，存兩次不會加兩次', function () {
    $this->actingAs(User::where('email', 'admin@example.test')->firstOrFail());
    $undoRepeaterFake = Repeater::fake();

    Livewire::test(CreateProduct::class)
        ->fillForm([
            'brand_id' => Brand::first()->id, 'name' => '後台新商品', 'status' => 'active', 'delivery_modes' => ['direct'],
            'variants' => [['sku' => 'T-NEW', 'name' => '後台新商品', 'price' => 299, 'shipping_class' => 'standard', 'stock_change' => 25, 'is_litter' => false]],
        ])
        ->call('create')
        ->assertHasNoFormErrors();

    $variant = variant('T-NEW');
    expect(Inventory::totals($variant->id)->on_hand)->toBe(25);

    // 前台買得到（以前後台新增的商品沒有庫存紀錄，結帳一律「庫存不足」）
    DB::transaction(fn () => $this->inventory->reserve(pendingOrder()->id, $variant->id, 2, now()->addMinutes(15)));

    $edit = Livewire::test(EditProduct::class, ['record' => $variant->product_id]);
    $key = array_key_first($edit->get('data.variants'));
    $edit->set("data.variants.{$key}.stock_change", 5)->call('save')->assertHasNoFormErrors();
    expect(Inventory::totals($variant->id)->on_hand)->toBe(30);

    $edit->call('save')->assertHasNoFormErrors();   // 增減已經清掉，不會再加一次
    expect(Inventory::totals($variant->id)->on_hand)->toBe(30);

    $undoRepeaterFake();
});
