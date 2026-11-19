<?php

namespace App\Enums;

/** stock：直接拉庫存，送出時預留；early_bird：確定訂單，要排產，享合約折扣 */
enum DistributorOrderType: string
{
    case Stock = 'stock';
    case EarlyBird = 'early_bird';
}
