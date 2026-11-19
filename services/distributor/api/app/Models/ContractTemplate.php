<?php

namespace App\Models;

use App\Enums\Incoterm;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** 業務自己的合約預設值，別人看不到。套用時複製一份，之後兩邊互不影響 */
class ContractTemplate extends Model
{
    protected $casts = ['incoterm' => Incoterm::class];

    /** @return HasMany<ContractTemplateItem, $this> */
    public function items(): HasMany
    {
        return $this->hasMany(ContractTemplateItem::class, 'template_id');
    }
}
