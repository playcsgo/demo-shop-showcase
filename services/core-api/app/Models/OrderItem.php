<?php

namespace App\Models;

use App\Enums\FulfillmentStatus;
use App\Enums\FulfillmentType;
use App\Enums\ShippingClass;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasOne;

class OrderItem extends Model
{
    protected $guarded = [];

    protected $casts = [
        'fulfillment_type' => FulfillmentType::class,
        'fulfillment_status' => FulfillmentStatus::class,
        'shipping_class' => ShippingClass::class,
        'appointment_at' => 'datetime',
    ];

    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class);
    }

    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class);
    }

    public function brand(): BelongsTo
    {
        return $this->belongsTo(Brand::class);
    }

    public function booking(): HasOne
    {
        return $this->hasOne(Booking::class);
    }

    public function refundableQty(): int
    {
        return $this->qty - $this->refunded_qty;
    }
}
