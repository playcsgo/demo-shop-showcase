<?php

namespace App\Enums;

/** 訂單狀態：只能往前轉移，轉移一律用條件式 UPDATE（§5.4） */
enum OrderStatus: string
{
    case PendingPayment = 'PENDING_PAYMENT';
    case Paid = 'PAID';
    case Fulfilling = 'FULFILLING';
    case Completed = 'COMPLETED';
    case PartiallyRefunded = 'PARTIALLY_REFUNDED';
    case Refunded = 'REFUNDED';
    case PaymentFailed = 'PAYMENT_FAILED';
    case Cancelled = 'CANCELLED';
}
