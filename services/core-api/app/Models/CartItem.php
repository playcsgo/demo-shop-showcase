<?php

namespace App\Models;

use App\Enums\FulfillmentType;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class CartItem extends Model
{
    protected $guarded = [];

    protected $casts = [
        'fulfillment_type' => FulfillmentType::class,
        'appointment_at' => 'datetime',
        'hold_expires_at' => 'datetime',
    ];

    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class);
    }
}
