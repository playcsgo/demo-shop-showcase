<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** 每次送出一筆：內容快照和退回原因。退回時只補上退回的欄位 */
class DistributorBatchRevision extends Model
{
    public $timestamps = false;

    protected $casts = ['snapshot' => 'array', 'submitted_at' => 'datetime', 'rejected_at' => 'datetime'];
}
