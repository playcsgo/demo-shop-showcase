<?php

namespace App\Domain\Distribution;

use App\Models\ContractItem;
use App\Models\ContractItemTier;
use App\Models\DistributorContract;
use App\Models\DistributorShop;

/**
 * Shop 商品＝active 合約的品項 ∩ shop_items。顯示和下單檢查都用這裡，不能分歧。
 * 國家禁令不參與計算，下單時才掃描
 */
class ShopCatalog
{
    /** @return list<array<string, mixed>> */
    public function forShop(DistributorShop $shop): array
    {
        $selected = $shop->items()->pluck('product_id')->all();

        return array_values(array_filter(
            $this->allowed($shop),
            fn (array $item) => in_array($item['product_id'], $selected, true),
        ));
    }

    /**
     * 合約允許的全部商品（設定頁用這份讓人勾選）。沒有生效的合約就是空的
     *
     * @return list<array<string, mixed>>
     */
    public function allowed(DistributorShop $shop): array
    {
        $contract = $this->activeContract($shop);
        if (! $contract) {
            return [];
        }

        $items = $contract->items()->with('product', 'tiers')->get();
        return $items->sortBy('product.sku')->values()->map(fn (ContractItem $i) => [
            'product_id' => $i->product_id,
            'sku' => $i->product->sku,
            'name' => $i->product->name,
            'temperature_class' => $i->product->temperature_class->value,
            'moq_cases' => $i->moq_cases,
            'case_size' => $i->case_size,
            'case_multiple' => $i->case_multiple,
            'tiers' => $i->tiers->sortBy('min_cases')->values()->map(fn (ContractItemTier $t) => $t->only('min_cases', 'unit_price_minor'))->all(),
        ])->all();
    }

    public function activeContract(DistributorShop $shop): ?DistributorContract
    {
        return DistributorContract::where('distributor_id', $shop->distributor_id)->where('status', 'active')->first();
    }
}
