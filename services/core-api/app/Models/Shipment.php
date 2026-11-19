<?php

namespace App\Models;

use App\Enums\ShippingClass;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Shipment extends Model
{
    protected $guarded = [];

    protected $casts = [
        'shipping_class' => ShippingClass::class,
        'last_event_at' => 'datetime',
    ];

    public function items(): HasMany
    {
        return $this->hasMany(ShipmentItem::class);
    }

    public function events(): HasMany
    {
        return $this->hasMany(ShipmentEvent::class)->orderBy('occurred_at');
    }

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class);
    }
}
