<?php

namespace App\Models;

use App\Domain\Catalog\StockLevel;
use App\Enums\ShippingClass;
use App\Http\Controllers\Api\CatalogController;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\Cache;

class ProductVariant extends Model
{
    protected $guarded = [];

    /** 寫入時刪快取（不是更新快取）：下一次讀取再從資料庫重建（§9.3） */
    protected static function booted(): void
    {
        static::saved(fn () => Cache::forget(CatalogController::CACHE_KEY));
        // 實體商品一定要有庫存紀錄（桶 0）：結帳預留庫存是條件式 UPDATE，沒有這一列就會被當成「庫存不足」
        static::created(function (ProductVariant $variant) {
            if (! $variant->isService()) {
                $variant->buckets()->firstOrCreate(['bucket_no' => 0], ['on_hand' => 0, 'reserved' => 0]);
            }
        });
        static::deleted(fn () => Cache::forget(CatalogController::CACHE_KEY));
    }

    protected $casts = [
        'is_litter' => 'boolean',
        'dimensions_mm' => 'array',
        'hot_since' => 'datetime',
        'shipping_class' => ShippingClass::class,
    ];

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    /** 庫存的每一桶（一般商品只有桶 0） */
    public function buckets(): HasMany
    {
        return $this->hasMany(Inventory::class, 'variant_id');
    }

    /** 所有桶加總（用已載入的 buckets，列表記得 with('variants.buckets')）；服務類商品 → null */
    public function stock(): ?StockLevel
    {
        return StockLevel::fromRows($this->buckets);
    }

    public function isService(): bool
    {
        return $this->shipping_class === ShippingClass::Service;
    }
}
