<?php

namespace App\Enums;

/** manager：設定 shop 顯示、下單、看訂單；buyer：下單、看訂單 */
enum DistributorUserRole: string
{
    case Manager = 'manager';
    case Buyer = 'buyer';
}
