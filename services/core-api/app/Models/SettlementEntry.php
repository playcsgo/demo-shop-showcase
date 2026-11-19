<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** 只新增、不修改；結算時只會填上 statement_id */
class SettlementEntry extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = [];

    protected $casts = ['occurred_at' => 'datetime'];

    public function brand(): BelongsTo
    {
        return $this->belongsTo(Brand::class);
    }
}
