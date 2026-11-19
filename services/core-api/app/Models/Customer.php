<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Foundation\Auth\User as Authenticatable;

/** 顧客（前台）。後台使用者是 User。 */
class Customer extends Authenticatable
{
    protected $guarded = [];

    protected $hidden = ['password'];

    protected $casts = ['password' => 'hashed'];

    public function cart(): HasOne
    {
        return $this->hasOne(Cart::class);
    }

    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    public function warehouseAccounts(): HasMany
    {
        return $this->hasMany(WarehouseAccount::class);
    }
}
