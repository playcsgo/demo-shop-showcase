<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** 合約允許的商品。沒列在合約裡的 SKU 就是不能買（AC-9） */
class ContractItem extends Model
{
    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'product_id');
    }

    /** @return HasMany<ContractItemTier, $this> */
    public function tiers(): HasMany
    {
        return $this->hasMany(ContractItemTier::class);
    }
}
