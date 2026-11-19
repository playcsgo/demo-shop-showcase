<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** 這個 SKU 在這個國家的 HS code，覆蓋 SKU 的預設值。只供參考；要透過 CountryRuleService 改，才有變更紀錄 */
class ProductCountryRule extends Model
{
    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'product_id');
    }

    /**
     * 變更紀錄沒有外鍵連回規則，靠同一組 SKU×國家對應
     *
     * @return HasMany<ProductCountryRuleChange, $this>
     */
    public function changes(): HasMany
    {
        return $this->hasMany(ProductCountryRuleChange::class, 'product_id', 'product_id')->where('country_code', $this->country_code);
    }
}
