<?php

namespace App\Enums;

enum FulfillmentStatus: string
{
    case Pending = 'PENDING';
    case Processing = 'PROCESSING';
    case Done = 'DONE';
    case Cancelled = 'CANCELLED';
    case Refunded = 'REFUNDED';
}
