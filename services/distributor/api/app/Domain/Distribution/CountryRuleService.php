<?php

namespace App\Domain\Distribution;

use App\Models\User;
use App\Models\ProductCountryRule;
use App\Models\ProductCountryRuleChange;
use Illuminate\Support\Facades\DB;

/** 各國的 HS code 全公司共用，可能被改錯：存檔和寫變更紀錄在同一個交易，不會有沒留紀錄的改動 */
class CountryRuleService
{
    /** @param  array<string, mixed>  $attributes */
    public function save(int $productId, string $country, array $attributes, User $by): ProductCountryRule
    {
        $after = ['hs_code' => ($attributes['hs_code'] ?? null) ?: null];

        return DB::transaction(function () use ($productId, $country, $after, $by) {
            $rule = ProductCountryRule::where('product_id', $productId)->where('country_code', $country)->lockForUpdate()->first()
                ?? new ProductCountryRule(['product_id' => $productId, 'country_code' => $country]);
            $before = $rule->exists ? $rule->only('hs_code') : null;
            if ($before === $after) {
                return $rule;
            }

            $rule->fill($after)->save();
            ProductCountryRuleChange::create([
                'product_id' => $productId, 'country_code' => $country, 'changed_by_user_id' => $by->id,
                'before' => $before, 'after' => $after,
            ]);

            return $rule;
        });
    }

    /** 刪除＝回到 SKU 的預設 HS code。紀錄的改後就寫沒有國家值 */
    public function delete(ProductCountryRule $rule, User $by): void
    {
        DB::transaction(function () use ($rule, $by) {
            ProductCountryRuleChange::create([
                'product_id' => $rule->product_id, 'country_code' => $rule->country_code, 'changed_by_user_id' => $by->id,
                'before' => $rule->only('hs_code'), 'after' => ['hs_code' => null],
            ]);
            $rule->delete();
        });
    }
}
