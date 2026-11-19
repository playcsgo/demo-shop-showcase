<?php

use App\Domain\Distribution\ContractActivator;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\Distribution\ContractTemplateApplier;
use App\Domain\Distribution\ContractValidator;
use App\Domain\DomainException;
use App\Enums\ContractStatus;
use App\Filament\Resources\ContractTemplates\Pages\ListContractTemplates;
use App\Filament\Resources\Distributors\Pages\EditDistributor;
use App\Filament\Resources\Distributors\RelationManagers\ContractsRelationManager;
use App\Models\ContractTemplate;
use App\Models\Distributor;
use App\Models\DistributorContract;
use Database\Seeders\DistributorDemoSeeder;
use Filament\Actions\Testing\TestAction;
use Livewire\Livewire;

beforeEach(function () {
    $this->seed(DistributorDemoSeeder::class);
    $this->salesA = staff('sales-a@example.test');
    $this->salesB = staff('sales-b@example.test');
    // 沒有種子合約的乾淨經銷商，測試從頭開通
    $this->d = Distributor::create(['code' => 'D-TEST', 'name' => '測試經銷商', 'currency' => 'USD', 'sales_user_id' => $this->salesA->id]);
    $this->d->shops()->create(['name' => '香港', 'country_code' => 'HK', 'city' => 'x', 'address' => 'x']);
    $this->d->shops()->create(['name' => '新加坡', 'country_code' => 'SG', 'city' => 'x', 'address' => 'x']);
});

/** 合約條款的基本樣子，測試只改想測的那一項 */
function terms(array $overrides = [], ?array $items = null): array
{
    return $overrides + [
        'incoterm' => 'FOB', 'prepay_bps' => 3000, 'early_bird_discount_bps' => 300, 'min_lead_days' => 60,
        'items' => $items ?? [contractItem('SB-DOG-FOOD')],
    ];
}

function contractItem(string $sku, array $overrides = []): array
{
    return $overrides + [
        'product_id' => product($sku)->id, 'moq_cases' => 50, 'case_size' => 6, 'case_multiple' => 1,
        'tiers' => [['min_cases' => 1, 'unit_price_minor' => 10000], ['min_cases' => 50, 'unit_price_minor' => 9500], ['min_cases' => 100, 'unit_price_minor' => 9000]],
    ];
}

function draftFor(Distributor $d, array $terms = []): DistributorContract
{
    $drafts = app(ContractDrafts::class);
    $draft = $drafts->blank($d);
    $drafts->save($draft, terms($terms));

    return $draft->fresh();
}

function template(int $ownerId, string $currency = 'USD'): ContractTemplate
{
    $t = ContractTemplate::create([
        'owner_user_id' => $ownerId, 'name' => '範本-'.uniqid(), 'currency' => $currency,
        'incoterm' => 'CIF', 'prepay_bps' => 2000, 'early_bird_discount_bps' => 500, 'min_lead_days' => 45,
    ]);
    $item = contractItem('SB-DOG-FOOD');
    $t->items()->create($item);

    return $t;
}

it('AC-5：業務只看得到自己的範本；別人的範本不能用 id 套用，也打不開', function () {
    $mine = template($this->salesA->id);
    $theirs = template($this->salesB->id);

    $this->actingAs($this->salesA);
    Livewire::test(ListContractTemplates::class)->assertCanSeeTableRecords([$mine])->assertCanNotSeeTableRecords([$theirs]);
    $this->get("/admin/contract-templates/{$theirs->id}/edit")->assertNotFound();

    expect(fn () => app(ContractTemplateApplier::class)->apply($theirs, $this->d, $this->salesA))
        ->toThrow(DomainException::class);
    expect($this->d->contracts()->count())->toBe(0);
});

it('AC-6：套用範本把條款、品項、階梯都複製進草稿；之後改範本或改草稿都不互相影響', function () {
    $template = template($this->salesA->id);
    $draft = app(ContractTemplateApplier::class)->apply($template, $this->d, $this->salesA);

    expect($draft->status)->toBe(ContractStatus::Draft)
        ->and($draft->source_template_id)->toBe($template->id)
        ->and($draft->incoterm->value)->toBe('CIF')
        ->and($draft->prepay_bps)->toBe(2000)
        ->and($draft->early_bird_discount_bps)->toBe(500)
        ->and($draft->min_lead_days)->toBe(45);
    $item = $draft->items()->with('tiers')->sole();
    expect($item->moq_cases)->toBe(50)->and($item->case_size)->toBe(6)
        ->and($item->tiers->sortBy('min_cases')->pluck('unit_price_minor')->all())->toBe([10000, 9500, 9000]);

    $template->update(['prepay_bps' => 9000]);
    $template->items()->update(['moq_cases' => 999]);
    expect($draft->fresh()->prepay_bps)->toBe(2000)->and($item->fresh()->moq_cases)->toBe(50);

    app(ContractDrafts::class)->save($draft, terms(['prepay_bps' => 1000]));
    expect($template->fresh()->prepay_bps)->toBe(9000);
});

it('AC-7：範本幣別和經銷商不同：不能套用', function () {
    expect(fn () => app(ContractTemplateApplier::class)->apply(template($this->salesA->id, 'TWD'), $this->d, $this->salesA))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('currency_mismatch'));
});

it('可以不套範本，直接建空白草稿；同一家同時只能有一份草稿', function () {
    $draft = app(ContractDrafts::class)->blank($this->d);

    expect($draft->status)->toBe(ContractStatus::Draft)->and($draft->items()->count())->toBe(0);
    expect(fn () => app(ContractDrafts::class)->blank($this->d))->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('draft_exists'));
});

it('空白草稿沒有品項：不能生效', function () {
    expect(fn () => app(ContractActivator::class)->activate(app(ContractDrafts::class)->blank($this->d), $this->salesA))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('contract_invalid'));
});

it('AC-8：生效後舊版變 superseded、資料保留、版本號遞增；重談從現行合約複製', function () {
    $activator = app(ContractActivator::class);
    $v1 = draftFor($this->d);
    $activator->activate($v1, $this->salesA);
    expect($v1->fresh()->status)->toBe(ContractStatus::Active)
        ->and($v1->fresh()->activated_by_user_id)->toBe($this->salesA->id)
        ->and($v1->fresh()->activated_at)->not->toBeNull();

    $v2 = app(ContractDrafts::class)->copyOfActive($this->d);
    expect($v2->version)->toBe(2)->and($v2->items()->count())->toBe(1);
    $activator->activate($v2, $this->salesA);

    expect($v1->fresh()->status)->toBe(ContractStatus::Superseded)
        ->and($v1->items()->count())->toBe(1)
        ->and($this->d->contracts()->where('status', 'active')->sole()->id)->toBe($v2->id);
});

it('AC-8：active 和 superseded 不能再修改', function () {
    $contract = draftFor($this->d);
    app(ContractActivator::class)->activate($contract, $this->salesA);

    expect(fn () => app(ContractDrafts::class)->save($contract->fresh(), terms()))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('contract_not_draft'));
});

it('AC-8：兩個人同時按生效只有一個成功', function () {
    $contract = draftFor($this->d);
    $userId = $this->salesA->id;

    $results = concurrently(2, fn () => app(ContractActivator::class)->activate(DistributorContract::findOrFail($contract->id), \App\Models\User::findOrFail($userId))->id);

    expect(collect($results)->where('ok', true))->toHaveCount(1)
        ->and(DistributorContract::where('distributor_id', $this->d->id)->where('status', 'active')->count())->toBe(1);
});

it('AC-10：存檔時檢查條款和階梯', function (array $bad, string $expected) {
    $draft = app(ContractDrafts::class)->blank($this->d);

    expect(fn () => app(ContractDrafts::class)->save($draft, $bad))
        ->toThrow(fn (DomainException $e) => expect($e->reason)->toBe('contract_invalid')->and($e->getMessage())->toContain($expected));
})->with([
    '沒有階梯' => fn () => [terms(items: [contractItem('SB-DOG-FOOD', ['tiers' => []])]), '階梯'],
    '門檻重複' => fn () => [terms(items: [contractItem('SB-DOG-FOOD', ['tiers' => [['min_cases' => 1, 'unit_price_minor' => 100], ['min_cases' => 1, 'unit_price_minor' => 90]]])]), '重複'],
    '第一階不是 1 箱' => fn () => [terms(items: [contractItem('SB-DOG-FOOD', ['tiers' => [['min_cases' => 50, 'unit_price_minor' => 100]]])]), '1 箱'],
    '金額為 0' => fn () => [terms(items: [contractItem('SB-DOG-FOOD', ['tiers' => [['min_cases' => 1, 'unit_price_minor' => 0]]])]), '大於 0'],
    '預付超過 100%' => fn () => [terms(['prepay_bps' => 10001]), '預付'],
    '折扣超過 100%' => fn () => [terms(['early_bird_discount_bps' => 10001]), '折扣'],
    '同 SKU 兩列' => fn () => [terms(items: [contractItem('SB-DOG-FOOD'), contractItem('SB-DOG-FOOD')]), '重複'],
    '箱規為 0' => fn () => [terms(items: [contractItem('SB-DOG-FOOD', ['case_size' => 0])]), '每箱'],
]);

it('AC-10：檢查失敗時草稿內容不變', function () {
    $draft = draftFor($this->d);

    expect(fn () => app(ContractDrafts::class)->save($draft, terms(items: [contractItem('SB-VITAMIN', ['tiers' => []])])))->toThrow(DomainException::class);

    expect($draft->items()->sole()->product_id)->toBe(product('SB-DOG-FOOD')->id);
});

it('AC-10：合約 CHECK 擋得住繞過程式直接寫入的比例', function () {
    expect(fn () => DistributorContract::create(['distributor_id' => $this->d->id, 'version' => 99, 'status' => 'draft', 'incoterm' => 'FOB',
        'prepay_bps' => 10001, 'early_bird_discount_bps' => 0, 'min_lead_days' => 1]))->toThrow(\Illuminate\Database\QueryException::class);
});

it('ContractValidator：好的條款沒有錯誤', function () {
    expect(app(ContractValidator::class)->errors(terms()))->toBe([]);
});

it('後台：業務套用範本後生效', function () {
    $this->actingAs($this->salesA);
    $template = template($this->salesA->id);
    $rm = fn () => Livewire::test(ContractsRelationManager::class, ['ownerRecord' => $this->d, 'pageClass' => EditDistributor::class]);

    $rm()->callAction(TestAction::make('applyTemplate')->table(), ['template_id' => $template->id])->assertHasNoFormErrors();
    $draft = $this->d->contracts()->sole();
    expect($draft->source_template_id)->toBe($template->id);

    $rm()->callAction(TestAction::make('activate')->table($draft));
    expect($draft->fresh()->status)->toBe(ContractStatus::Active);
});

it('後台：套用範本的選單只有自己的、幣別相同的範本', function () {
    $this->actingAs($this->salesA);
    $theirs = template($this->salesB->id);
    $twd = template($this->salesA->id, 'TWD');

    foreach ([$theirs, $twd] as $bad) {
        Livewire::test(ContractsRelationManager::class, ['ownerRecord' => $this->d, 'pageClass' => EditDistributor::class])
            ->callAction(TestAction::make('applyTemplate')->table(), ['template_id' => $bad->id])
            ->assertHasFormErrors(['template_id']);
    }
    expect($this->d->contracts()->count())->toBe(0);
});

it('後台：沒有可選的範本時，選單下面說原因', function () {
    $this->actingAs($this->salesA);
    $this->d->update(['currency' => 'JPY']);   // 種子只有 USD、TWD 的範本
    $hint = fn () => Livewire::test(ContractsRelationManager::class, ['ownerRecord' => $this->d, 'pageClass' => EditDistributor::class])->instance()->templateHint();

    template($this->salesB->id, 'JPY');   // 別人的範本不算
    expect($hint())->toBe('你還沒有 JPY 的範本。先到「合約範本」建一份，或改用「空白草稿」');

    template($this->salesA->id, 'JPY');
    expect($hint())->toBeNull();
});

it('合約生效過的經銷商不能改幣別', function () {
    $this->actingAs($this->salesA);
    app(ContractDrafts::class)->blank($this->d)->update(['status' => 'active']);

    Livewire::test(EditDistributor::class, ['record' => $this->d->id])
        ->assertFormFieldIsDisabled('currency');
});
