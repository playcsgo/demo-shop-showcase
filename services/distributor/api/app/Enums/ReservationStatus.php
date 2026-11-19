<?php

namespace App\Enums;

/** 預留：HELD（下單時佔住）→ COMMITTED（付款成功，真的扣掉）或 RELEASED（付款失敗、取消，還回去） */
enum ReservationStatus: string
{
    case Held = 'HELD';
    case Committed = 'COMMITTED';
    case Released = 'RELEASED';
}
