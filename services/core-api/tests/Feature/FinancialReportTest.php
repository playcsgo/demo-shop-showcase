<?php

use App\Filament\Pages\FinancialReport;
use App\Models\Brand;
use App\Models\User;
use Livewire\Livewire;

// 財報：每個品牌一列；淨收入 = 銷售 − 退款 − 手續費 − 抽成。看得到哪些品牌由 brandScope 決定

function reportAs(string $email)
{
    test()->actingAs(User::where('email', $email)->firstOrFail());

    return Livewire::test(FinancialReport::class);
}

function brandCode(string $code): Brand
{
    return Brand::where('project_code', $code)->firstOrFail();
}

beforeEach(function () {
    $this->travelTo('2030-01-15 10:00:00');
    $order = paidOrder([['DCS-DH-M', 1], ['DCS-LIT-1', 2]]);   // AK（汪）3200、MT（喵）399×2
    $item = $order->items->firstWhere('sku', 'DCS-LIT-1');
    $refund = $order->refunds()->create(['payment_id' => $order->payment->id, 'amount' => 399, 'reason' => 'cs', 'status' => 'SUCCEEDED', 'succeeded_at' => now(), 'idempotency_key' => 'r-report']);
    $refund->items()->create(['order_item_id' => $item->id, 'qty' => 1, 'amount' => 399]);
});

it('財報金額：汪的品牌沒有抽成；喵的品牌抽成退款會回沖', function () {
    reportAs('admin@example.test')
        ->assertTableColumnStateSet('gross', 3200, brandCode('AK'))
        ->assertTableColumnStateSet('fees', 64, brandCode('AK'))                    // 3200 × 2% = 64
        ->assertTableColumnStateSet('commission', 0, brandCode('AK'))
        ->assertTableColumnStateSet('net_income', 3200 - 64, brandCode('AK'))
        ->assertTableColumnStateSet('gross', 798, brandCode('MT'))
        ->assertTableColumnStateSet('refunds', 399, brandCode('MT'))
        ->assertTableColumnStateSet('commission', 119 - 59, brandCode('MT'))       // 798 × 15% − 399 × 15%
        ->assertTableColumnStateSet('net_income', 798 - 399 - 15 - 60, brandCode('MT'))
        ->assertSee('NT$ '.number_format(3136 + 60));                              // 汪的總收入
});

it('admin、財務看全部品牌', function (string $email) {
    reportAs($email)->assertCanSeeTableRecords(Brand::all())->assertSee('汪的總收入');
})->with(['admin@example.test', 'finance@example.test']);

it('operator 看自己法人底下所有品牌', function () {
    reportAs('wang-operator@example.test')
        ->assertCanSeeTableRecords([brandCode('AK'), brandCode('SB')])
        ->assertCanNotSeeTableRecords([brandCode('BC'), brandCode('MT')])
        ->assertDontSee('汪的總收入');
    reportAs('miao-operator@example.test')
        ->assertCanSeeTableRecords([brandCode('BC'), brandCode('MT')])
        ->assertCanNotSeeTableRecords([brandCode('AK'), brandCode('SB')]);
});

it('品牌經理只看自己的品牌', function () {
    $sbOnly = User::create(['name' => 'SB 經理', 'email' => 'sb-manager@example.test', 'password' => 'password']);
    $sbOnly->assignRole('brand_manager');
    $sbOnly->brands()->attach(brandCode('SB'));

    reportAs('sb-manager@example.test')
        ->assertCanSeeTableRecords([brandCode('SB')])
        ->assertCanNotSeeTableRecords([brandCode('AK'), brandCode('BC'), brandCode('MT')]);
    reportAs('bc-manager@example.test')
        ->assertCanSeeTableRecords([brandCode('BC')])
        ->assertCanNotSeeTableRecords([brandCode('AK'), brandCode('SB')]);
});

it('客服看不到財報', function () {
    $this->actingAs(User::where('email', 'cs@example.test')->firstOrFail());

    $this->get(FinancialReport::getUrl())->assertForbidden();
});
