<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class SettlementStatement extends Model
{
    protected $guarded = [];

    protected $casts = ['confirmed_at' => 'datetime'];

    public function entries(): HasMany
    {
        return $this->hasMany(SettlementEntry::class, 'statement_id');
    }

    public function legalEntity(): BelongsTo
    {
        return $this->belongsTo(LegalEntity::class);
    }
}
