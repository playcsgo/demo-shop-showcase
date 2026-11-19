<?php

namespace App\Domain\Catalog;

use Illuminate\Support\Collection;

/** 一個商品的庫存（所有桶加總）：顯示、檢查用；扣庫存一律走 InventoryService */
final readonly class StockLevel
{
    public function __construct(public int $on_hand, public int $reserved, public int $buckets) {}

    /** @param  Collection<int, object{on_hand: int, reserved: int}>  $rows  inventory 的列（一桶一列） */
    public static function fromRows(Collection $rows): ?self
    {
        return $rows->isEmpty() ? null : new self((int) $rows->sum('on_hand'), (int) $rows->sum('reserved'), $rows->count());
    }

    public function available(): int
    {
        return $this->on_hand - $this->reserved;
    }
}
