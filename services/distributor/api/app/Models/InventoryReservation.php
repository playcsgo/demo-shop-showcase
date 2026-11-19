<?php

namespace App\Models;

use App\Enums\ReservationStatus;
use Illuminate\Database\Eloquent\Model;

class InventoryReservation extends Model
{
    protected $casts = ['status' => ReservationStatus::class];
}
