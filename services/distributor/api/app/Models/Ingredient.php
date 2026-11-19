<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** 共用的成分清單：SKU 和國家禁令都從這裡選，比對才可靠 */
class Ingredient extends Model
{
    /** @return BelongsToMany<Product, $this> */
    public function products(): BelongsToMany
    {
        return $this->belongsToMany(Product::class, 'ingredient_product', 'ingredient_id', 'product_id');
    }

    /** @return HasMany<CountryIngredientBan, $this> */
    public function bans(): HasMany
    {
        return $this->hasMany(CountryIngredientBan::class);
    }

    /** 變更紀錄也算：刪掉會讓歷史對不到成分 */
    public function isInUse(): bool
    {
        return $this->products()->exists() || $this->bans()->exists()
            || CountryIngredientBanChange::where('ingredient_id', $this->id)->exists();
    }
}
