<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class SupplierContract extends Model
{
    protected $guarded = [];

    protected $casts = ['effective_from' => 'date'];
}
