<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** 服務類（健康檢查）預約：沒有物流欄位 */
class Booking extends Model
{
    protected $guarded = [];

    protected $casts = ['appointment_at' => 'datetime', 'hold_expires_at' => 'datetime'];

    public function orderItem(): BelongsTo
    {
        return $this->belongsTo(OrderItem::class);
    }
}
