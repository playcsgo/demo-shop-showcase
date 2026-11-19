<?php

namespace App\Domain\Distribution;

use App\Domain\DomainException;
use App\Enums\ContractStatus;
use App\Enums\Incoterm;
use App\Models\Distributor;
use App\Models\DistributorContract;
use Illuminate\Support\Facades\DB;

/** 合約草稿：建立和存檔。鎖經銷商那一列：版本號和「同時只有一份草稿」才不會被兩個人同時按壞 */
class ContractDrafts
{
    public function __construct(private ContractValidator $validator) {}

    public function blank(Distributor $distributor): DistributorContract
    {
        return $this->create($distributor, [
            'incoterm' => Incoterm::FOB->value, 'prepay_bps' => 0, 'early_bird_discount_bps' => 0, 'min_lead_days' => 60, 'items' => [],
        ]);
    }

    /** 重談：從現行合約複製一份草稿，逐項改完再生效 */
    public function copyOfActive(Distributor $distributor): DistributorContract
    {
        $active = $distributor->contracts()->where('status', ContractStatus::Active)->first()
            ?? throw new DomainException('no_active_contract', '這家經銷商還沒有生效的合約', 409);

        return $this->create($distributor, $active->toTerms());
    }

    /** @param  array<string, mixed>  $terms */
    public function create(Distributor $distributor, array $terms, ?int $sourceTemplateId = null): DistributorContract
    {
        return DB::transaction(function () use ($distributor, $terms, $sourceTemplateId) {
            Distributor::whereKey($distributor->id)->lockForUpdate()->sole();
            if ($distributor->contracts()->where('status', ContractStatus::Draft)->exists()) {
                throw new DomainException('draft_exists', '這家經銷商已經有一份草稿', 409);
            }

            $contract = $distributor->contracts()->create([
                'version' => (int) $distributor->contracts()->max('version') + 1,
                'status' => ContractStatus::Draft,
                'source_template_id' => $sourceTemplateId,
            ] + collect($terms)->only('incoterm', 'prepay_bps', 'early_bird_discount_bps', 'min_lead_days')->all());
            $this->replaceItems($contract, $terms['items']);

            return $contract;
        });
    }

    /** 整份替換，不逐列比對：表單每次都送完整內容 @param  array<string, mixed>  $terms */
    public function save(DistributorContract $contract, array $terms): void
    {
        $this->validator->assertValid($terms);

        DB::transaction(function () use ($contract, $terms) {
            $updated = DistributorContract::whereKey($contract->id)->where('status', ContractStatus::Draft)
                ->update(collect($terms)->only('incoterm', 'prepay_bps', 'early_bird_discount_bps', 'min_lead_days')->all());
            if ($updated === 0 && ! DistributorContract::whereKey($contract->id)->where('status', ContractStatus::Draft)->exists()) {
                throw new DomainException('contract_not_draft', '只有草稿可以修改', 409);
            }
            $contract->items()->delete();
            $this->replaceItems($contract, $terms['items']);
        });
    }

    /** @param  array<int, array<string, mixed>>  $items */
    private function replaceItems(DistributorContract $contract, array $items): void
    {
        foreach ($items as $item) {
            $created = $contract->items()->create(collect($item)->only('product_id', 'moq_cases', 'case_size', 'case_multiple')->all());
            $created->tiers()->createMany(array_map(fn ($t) => ['min_cases' => $t['min_cases'], 'unit_price_minor' => $t['unit_price_minor']], $item['tiers']));
        }
    }
}
