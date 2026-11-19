<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** 只新增、不修改 */
class WarehouseLedger extends Model
{
    protected $table = 'warehouse_ledger';

    public const UPDATED_AT = null;

    protected $guarded = [];
}
