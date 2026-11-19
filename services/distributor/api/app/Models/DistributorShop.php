<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** 經銷商的收貨地點，一個地址一張單。由業務建立：國家決定要跳哪些警告 */
class DistributorShop extends Model
{
    /** 用選單不用自由輸入：打錯國碼（例如 HKG），國家規則的禁令就會默默對不上 */
    public const COUNTRIES = ['HK' => '香港', 'SG' => '新加坡', 'MO' => '澳門', 'TW' => '台灣', 'MY' => '馬來西亞', 'JP' => '日本', 'US' => '美國', 'IN' => '印度'];

    /** @return HasMany<ShopItem, $this> */
    public function items(): HasMany
    {
        return $this->hasMany(ShopItem::class, 'shop_id');
    }

    /** @return BelongsTo<Distributor, $this> */
    public function distributor(): BelongsTo
    {
        return $this->belongsTo(Distributor::class);
    }
}
