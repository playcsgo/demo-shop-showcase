<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ContractTemplateItem extends Model
{
    protected $casts = ['tiers' => 'array'];
}
