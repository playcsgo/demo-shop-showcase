<?php

namespace App\Enums;

/** PENDING → IN_PROGRESS（早鳥是排產中，現貨是待出貨）→ SHIPPED → DELIVERED */
enum DistributorOrderStatus: string
{
    case Pending = 'PENDING';
    case InProgress = 'IN_PROGRESS';
    case Shipped = 'SHIPPED';
    case Delivered = 'DELIVERED';
}
