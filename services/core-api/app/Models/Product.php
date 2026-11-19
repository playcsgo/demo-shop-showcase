<?php

namespace App\Models;

use App\Http\Controllers\Api\CatalogController;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Storage;

class Product extends Model
{
    protected $guarded = [];

    /** 寫入時刪快取（不是更新快取）：下一次讀取再從資料庫重建（§9.3） */
    protected static function booted(): void
    {
        static::saved(fn () => Cache::forget(CatalogController::CACHE_KEY));
        static::deleted(fn () => Cache::forget(CatalogController::CACHE_KEY));
    }

    protected $casts = [
        'delivery_modes' => 'array',
        'species' => 'array',
        'life_stage' => 'array',
        'concerns' => 'array',
        'warnings' => 'array',
        'feeding' => 'array',
    ];

    public function brand(): BelongsTo
    {
        return $this->belongsTo(Brand::class);
    }

    public function variants(): HasMany
    {
        return $this->hasMany(ProductVariant::class);
    }

    /** 圖片網址：資料庫只存 S3 的路徑，網址由 s3 disk 的 url 設定組出來（本機走 core 的 /media，正式環境換成 CDN） */
    public function imageUrl(): ?string
    {
        return $this->image_path ? Storage::disk('s3')->url($this->image_path) : null;
    }

    /** 依 法人 → 品牌 → 商品 排序（前台目錄與後台列表共用）；用子查詢而不是 join，才不會和其他 where 條件撞欄位名稱 */
    public function scopeOrderByOwner(Builder $query): Builder
    {
        return $query
            ->orderBy(Brand::select('legal_entity_id')->whereColumn('brands.id', 'products.brand_id'))
            ->orderBy('products.brand_id')
            ->orderBy('products.id');
    }

    public function allows(string $fulfillmentType): bool
    {
        return in_array($fulfillmentType, $this->delivery_modes, true);
    }
}
