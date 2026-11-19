<?php

namespace App\Models;

use App\Enums\ContractStatus;
use App\Enums\Incoterm;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** 經銷商的合約。同一家同時最多一份 draft、一份 active；active 和 superseded 不能再修改 */
class DistributorContract extends Model
{
    protected $casts = ['status' => ContractStatus::class, 'incoterm' => Incoterm::class, 'activated_at' => 'datetime'];

    /** @return BelongsTo<Distributor, $this> */
    public function distributor(): BelongsTo
    {
        return $this->belongsTo(Distributor::class);
    }

    /** @return HasMany<ContractItem, $this> */
    public function items(): HasMany
    {
        return $this->hasMany(ContractItem::class, 'contract_id');
    }

    /**
     * 表單和 ContractDrafts::save() 共用的資料格式
     *
     * @return array<string, mixed>
     */
    public function toTerms(): array
    {
        return $this->only('prepay_bps', 'early_bird_discount_bps', 'min_lead_days') + [
            'incoterm' => $this->incoterm->value,
            'items' => $this->items()->with('tiers')->get()->map(fn (ContractItem $i) => $i->only('product_id', 'moq_cases', 'case_size', 'case_multiple') + [
                'tiers' => $i->tiers->sortBy('min_cases')->values()->map(fn (ContractItemTier $t) => $t->only('min_cases', 'unit_price_minor'))->all(),
            ])->all(),
        ];
    }
}
