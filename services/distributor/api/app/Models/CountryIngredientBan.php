<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** 國家禁某個成分，有列就是禁令。只產生警告，不擋流程；要透過 CountryBanService 改，才有變更紀錄 */
class CountryIngredientBan extends Model
{
    /** @return BelongsTo<Ingredient, $this> */
    public function ingredient(): BelongsTo
    {
        return $this->belongsTo(Ingredient::class);
    }

    /**
     * 變更紀錄沒有外鍵連回禁令，靠同一組國家×成分對應：解除後再新增，歷史還接得上
     *
     * @return HasMany<CountryIngredientBanChange, $this>
     */
    public function changes(): HasMany
    {
        return $this->hasMany(CountryIngredientBanChange::class, 'ingredient_id', 'ingredient_id')->where('country_code', $this->country_code);
    }
}
