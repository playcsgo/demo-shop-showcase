<?php

namespace App\Models;

use App\Domain\Catalog\StockLevel;
use Illuminate\Database\Eloquent\Model;

/**
 * 庫存的一桶（主鍵 variant_id＋bucket_no）。一般商品只有桶 0；熱賣模式拆成好幾桶（InventoryBuckets）。
 * 只用來讀和建立：Eloquent 不支援複合主鍵的 update，扣庫存一律走 InventoryService 的條件式 UPDATE。
 */
class Inventory extends Model
{
    protected $table = 'inventory';

    protected $primaryKey = null;

    public $incrementing = false;

    protected $guarded = [];

    /** 一個商品所有桶的加總；沒有庫存紀錄（服務類商品）→ null */
    public static function totals(int $variantId): ?StockLevel
    {
        return StockLevel::fromRows(static::where('variant_id', $variantId)->get());
    }

    public function available(): int
    {
        return $this->on_hand - $this->reserved;
    }
}
