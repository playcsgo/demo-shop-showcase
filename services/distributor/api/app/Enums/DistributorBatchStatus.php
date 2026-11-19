<?php

namespace App\Enums;

enum DistributorBatchStatus: string
{
    case InReview = 'IN_REVIEW';
    case Rejected = 'REJECTED';
    case AwaitingPayment = 'AWAITING_PAYMENT';
    case AwaitingStart = 'AWAITING_START';   // 預付 0%：審核通過後等業務按開始
    case Processing = 'PROCESSING';          // 早鳥是排產中，現貨是處理中
    case Completed = 'COMPLETED';
    case Cancelled = 'CANCELLED';
}
