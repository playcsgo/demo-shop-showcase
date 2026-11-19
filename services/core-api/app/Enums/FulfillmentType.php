<?php

namespace App\Enums;

enum FulfillmentType: string
{
    case Direct = 'direct';             // 直送
    case Warehouse = 'warehouse';       // 寄倉
    case Subscription = 'subscription'; // 訂閱
    case Booking = 'booking';           // 預約（服務）
}
