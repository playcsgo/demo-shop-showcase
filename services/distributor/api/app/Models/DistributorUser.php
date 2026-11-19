<?php

namespace App\Models;

use App\Enums\DistributorUserRole;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Foundation\Auth\User as Authenticatable;

/** 經銷商的帳號（和員工 User 完全分開）。密碼由業務設定和重設，經銷商不能自己改 */
class DistributorUser extends Authenticatable
{
    protected $hidden = ['password'];

    protected $casts = ['password' => 'hashed', 'role' => DistributorUserRole::class];

    /** @return BelongsTo<Distributor, $this> */
    public function distributor(): BelongsTo
    {
        return $this->belongsTo(Distributor::class);
    }
}
