<?php

use App\Domain\Settlement\StatementGenerator;
use App\Filament\Resources\Products\Pages\ListProducts;
use App\Models\Product;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Livewire\Livewire;

function admin(string $email): User
{
    return User::where('email', $email)->firstOrFail();
}

beforeEach(function () {
    $this->wangOnly = paidOrder([['DCS-DCAN-BEEF-165', 1], ['DCS-CAL-60', 2]]);     // 只有汪的品牌
    $this->mixed = paidOrder([['DCS-DH-M', 1], ['DCS-CAN-DUCK-80', 2]]);    // 汪（秋田）＋喵（藍貓）
});

it('藍貓品牌經理：看不到只有汪品牌的訂單、也看不到汪的商品', function () {
    $this->actingAs(admin('bc-manager@example.test'));

    $this->get("/admin/orders/{$this->wangOnly->id}")->assertNotFound();
    $this->get('/admin/products/'.variant('DCS-DH-M')->product_id)->assertNotFound();
    $this->get("/admin/orders/{$this->mixed->id}")->assertOk()
        ->assertSee('鮮肉主食罐')->assertDontSee('陶朱隱園');   // 混合訂單只看得到自己的明細
});

it('秋田品牌經理：商品列表只有 AK，看不到同屬汪的 SB', function () {
    $this->actingAs(admin('ak-manager@example.test'));
    $ak = Product::whereHas('brand', fn ($q) => $q->where('project_code', 'AK'))->get();
    $others = Product::whereHas('brand', fn ($q) => $q->where('project_code', '!=', 'AK'))->get();

    Livewire::test(ListProducts::class)
        ->assertCanSeeTableRecords($ak)->assertCanNotSeeTableRecords($others);
    $this->get('/admin/products/'.variant('DCS-CAL-60')->product_id)->assertNotFound();
});

it('客服：可以看訂單，但不能改商品、看不到月結單', function () {
    $this->actingAs(admin('cs@example.test'));

    $this->get("/admin/orders/{$this->mixed->id}")->assertOk();
    $this->get('/admin/products/'.variant('DCS-LIT-1')->product_id.'/edit')->assertForbidden();
    $this->get('/admin/settlement-statements')->assertForbidden();
});

function miaoStatement()
{
    return app(StatementGenerator::class)->generate(DB::table('legal_entities')->where('code', 'MIAO')->value('id'), now()->format('Y-m'));
}

it('財務：看得到所有訂單與月結單', function () {
    $s = miaoStatement();
    $this->actingAs(admin('finance@example.test'));

    $this->get("/admin/orders/{$this->wangOnly->id}")->assertOk();
    $this->get("/admin/settlement-statements/{$s->id}")->assertOk();
});

it('汪品牌經理：看不到喵的月結單（只能看自己品牌所屬法人的）', function () {
    $s = miaoStatement();
    $this->actingAs(admin('wang-manager@example.test'));

    $this->get("/admin/settlement-statements/{$s->id}")->assertNotFound();
});

it('沒有任何角色的帳號不能進後台', function () {
    $nobody = User::create(['name' => 'x', 'email' => 'nobody@example.test', 'password' => 'password']);

    $this->actingAs($nobody)->get('/admin')->assertForbidden();
});
