<?php

namespace App\Models;

use App\Domain\DomainException;
use App\Enums\TemperatureClass;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

/** 經銷商自己的商品，和商店分開 */
class Product extends Model
{
    protected $casts = [
        'no_ingredients' => 'boolean',
        'temperature_class' => TemperatureClass::class,
    ];

    protected static function booted(): void
    {
        // 一定要有一列庫存：之後扣庫存是條件式 UPDATE，沒有這一列就會被當成庫存不足
        static::created(fn (Product $product) => $product->inventory()->create(['on_hand' => 0]));
        static::updating(function (Product $product) {
            if ($product->isDirty('sku')) {
                throw new DomainException('code_immutable', 'SKU 建立後不能修改');
            }
        });
    }

    /** 有訂單或預留就不能刪：歷史訂單要完整 */
    public function hasOrderHistory(): bool
    {
        return DistributorOrderItem::where('product_id', $this->id)->exists()
            || InventoryReservation::where('product_id', $this->id)->exists();
    }

    /** @return BelongsToMany<Ingredient, $this> */
    public function ingredients(): BelongsToMany
    {
        return $this->belongsToMany(Ingredient::class);
    }

    /**
     * 各國的 HS code，覆蓋這裡的預設值
     *
     * @return HasMany<ProductCountryRule, $this>
     */
    public function countryRules(): HasMany
    {
        return $this->hasMany(ProductCountryRule::class);
    }

    /** @return HasOne<Inventory, $this> */
    public function inventory(): HasOne
    {
        return $this->hasOne(Inventory::class);
    }
}
