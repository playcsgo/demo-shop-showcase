<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class LegalEntity extends Model
{
    protected $guarded = [];

    public function brands(): HasMany
    {
        return $this->hasMany(Brand::class);
    }

    public function contracts(): HasMany
    {
        return $this->hasMany(SupplierContract::class);
    }

    public function isPlatform(): bool
    {
        return $this->role === 'platform';
    }

    /** 某個時間點有效的抽成；汪自己（平台）不抽成 */
    public function commissionBpsAt(\DateTimeInterface $at): int
    {
        if ($this->isPlatform()) {
            return 0;
        }

        return (int) $this->contracts()
            ->where('effective_from', '<=', $at->format('Y-m-d'))
            ->orderByDesc('effective_from')
            ->value('commission_bps');
    }
}
