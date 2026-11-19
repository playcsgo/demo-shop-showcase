<?php

namespace App\Models;

use App\Domain\DomainException;
use App\Enums\ContractStatus;
use App\Enums\DistributorStatus;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

/** 經銷商：付款主體。一個幣別，由一個業務負責（sales_user_id 就是後台的資料範圍） */
class Distributor extends Model
{
    protected static function booted(): void
    {
        static::updating(function (Distributor $d) {
            if ($d->isDirty('code')) {
                throw new DomainException('code_immutable', '經銷商代碼建立後不能修改');
            }
        });
    }

    public function hasOrders(): bool
    {
        return DistributorBatch::where('distributor_id', $this->id)->exists();
    }

    protected $casts = ['status' => DistributorStatus::class];

    /** @return BelongsTo<User, $this> */
    public function sales(): BelongsTo
    {
        return $this->belongsTo(User::class, 'sales_user_id');
    }

    /** @return HasMany<DistributorUser, $this> */
    public function users(): HasMany
    {
        return $this->hasMany(DistributorUser::class);
    }

    /** @return HasMany<DistributorContract, $this> */
    public function contracts(): HasMany
    {
        return $this->hasMany(DistributorContract::class);
    }

    /**
     * 目前生效的合約：查價和可購商品都只看這一份
     *
     * @return HasOne<DistributorContract, $this>
     */
    public function activeContract(): HasOne
    {
        return $this->hasOne(DistributorContract::class)->where('status', ContractStatus::Active);
    }

    /** @return HasMany<DistributorShop, $this> */
    public function shops(): HasMany
    {
        return $this->hasMany(DistributorShop::class);
    }
}
