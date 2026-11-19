<?php

use App\Domain\DomainException;
use App\Domain\Settlement\SettlementRecorder;
use App\Domain\Settlement\StatementGenerator;
use App\Filament\Resources\SettlementStatements\Widgets\UnsettledTotals;
use App\Models\LegalEntity;
use App\Models\RefundItem;
use App\Models\SettlementStatement;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Livewire\Livewire;

beforeEach(function () {
    $this->recorder = app(SettlementRecorder::class);
    $this->generator = app(StatementGenerator::class);
    $this->miao = LegalEntity::where('code', 'MIAO')->first();
});

it('混合訂單：只有喵（供應商）的明細會記應付款；汪自己的品牌不記', function () {
    $order = paidOrder([['DCS-DCAN-BEEF-165', 1], ['DCS-LIT-1', 2]]); // 成犬罐 75（汪）、貓砂 399×2（喵）

    $this->recorder->recordSale($order);
    $this->recorder->recordSale($order); // 重複執行

    $entries = DB::table('settlement_entries')->orderBy('id')->get();
    expect($entries)->toHaveCount(3)
        ->and($entries->pluck('legal_entity_id')->unique()->all())->toBe([$this->miao->id])
        ->and($entries->pluck('amount', 'type')->all())->toBe([
            'SALE' => 798,
            'COMMISSION' => -119,   // 798 × 15% = 119.7 → 無條件捨去
            'PAYMENT_FEE' => -15,   // 798 × 2% = 15.96 → 15
        ]);
});

it('月結：已結算的月份又退款 → 不改舊結算單，退款進下個月', function () {
    $this->travelTo('2026-10-20 10:00:00');
    $order = paidOrder([['DCS-LIT-1', 2]]);
    $this->recorder->recordSale($order);

    $this->travelTo('2026-11-01 01:00:00');
    $october = $this->generator->generate($this->miao->id, '2026-10');
    $this->generator->confirm($october, 1);

    $this->travelTo('2026-11-05 10:00:00');
    $item = $order->items->first();
    $refund = $order->refunds()->create(['payment_id' => $order->payment->id, 'amount' => 399, 'reason' => 'cs', 'status' => 'SUCCEEDED', 'idempotency_key' => 'r1']);
    $refundItem = $refund->items()->create(['order_item_id' => $item->id, 'qty' => 1, 'amount' => 399]);
    $this->recorder->recordRefund(RefundItem::find($refundItem->id));

    $this->travelTo('2026-12-01 01:00:00');
    $november = $this->generator->generate($this->miao->id, '2026-11');

    expect(SettlementStatement::find($october->id)->payable)->toBe(798 - 119 - 15)
        ->and($november->refunds)->toBe(-399)
        ->and($november->commission)->toBe(59)          // 抽成回沖 399 × 15%
        ->and($november->payable)->toBe(-399 + 59)
        ->and($this->generator->mismatchedStatements())->toBe([]);
});

it('已確認的結算單不能再重新產生', function () {
    $s = $this->generator->generate($this->miao->id, '2026-10');
    $this->generator->confirm($s, 1);

    expect(fn () => $this->generator->generate($this->miao->id, '2026-10'))->toThrow(DomainException::class);
});

it('月結單頁面：還沒產生結算單時，也看得到未結算分錄的累計金額（依可看的法人過濾）', function () {
    $this->recorder->recordSale(paidOrder([['DCS-LIT-1', 2]]));   // 喵：798、抽成 -119、手續費 -15

    $this->actingAs(User::where('email', 'finance@example.test')->firstOrFail());
    Livewire::test(UnsettledTotals::class)
        ->assertCanSeeTableRecords([$this->miao])
        ->assertTableColumnStateSet('payable', 798 - 119 - 15, $this->miao);

    $this->actingAs(User::where('email', 'bc-manager@example.test')->firstOrFail());
    Livewire::test(UnsettledTotals::class)
        ->assertCanSeeTableRecords([$this->miao]);

    $this->actingAs(User::where('email', 'wang-manager@example.test')->firstOrFail());
    Livewire::test(UnsettledTotals::class)
        ->assertCountTableRecords(0);
});
