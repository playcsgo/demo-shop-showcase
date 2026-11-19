<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** 扣庫存一律走 InventoryService 的條件式 UPDATE，不要 $inventory->save() */
class Inventory extends Model
{
    protected $table = 'inventory';

    protected $primaryKey = 'product_id';

    public $incrementing = false;

    public function available(): int
    {
        return $this->on_hand - $this->reserved;
    }
}
