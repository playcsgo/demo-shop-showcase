<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** 只新增，不修改。經銷商只看最新的 ETA，這份紀錄是內部用的 */
class DistributorOrderEtaChange extends Model
{
    public const UPDATED_AT = null;

    protected $casts = ['before_date' => 'date', 'after_date' => 'date'];

    /** @return BelongsTo<User, $this> */
    public function changedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'changed_by_user_id');
    }
}
