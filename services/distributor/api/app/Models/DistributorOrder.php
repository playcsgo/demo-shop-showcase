<?php

namespace App\Models;

use App\Enums\DistributorOrderStatus;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** 批次裡一個 shop 一張。ETA、出貨、送達都在這層，以後有他國工廠可以逐張分配 */
class DistributorOrder extends Model
{
    protected $casts = ['status' => DistributorOrderStatus::class, 'requested_ship_date' => 'date', 'eta_date' => 'date', 'shipped_at' => 'datetime', 'delivered_at' => 'datetime'];

    /** @return BelongsTo<DistributorBatch, $this> */
    public function batch(): BelongsTo
    {
        return $this->belongsTo(DistributorBatch::class, 'batch_id');
    }

    /** @return BelongsTo<DistributorShop, $this> */
    public function shop(): BelongsTo
    {
        return $this->belongsTo(DistributorShop::class, 'shop_id');
    }

    /** @return HasMany<DistributorOrderEtaChange, $this> */
    public function etaChanges(): HasMany
    {
        return $this->hasMany(DistributorOrderEtaChange::class, 'order_id');
    }

    /** @return HasMany<DistributorOrderItem, $this> */
    public function items(): HasMany
    {
        return $this->hasMany(DistributorOrderItem::class, 'order_id');
    }
}
