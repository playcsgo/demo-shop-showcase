<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** 只新增，不修改 */
class CountryIngredientBanChange extends Model
{
    public const UPDATED_AT = null;

    protected $casts = ['before' => 'array', 'after' => 'array'];

    /** @return BelongsTo<User, $this> */
    public function changedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'changed_by_user_id');
    }
}
