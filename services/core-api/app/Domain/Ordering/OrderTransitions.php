<?php

namespace App\Domain\Ordering;

use App\Domain\Observability\OrderStageMetrics;
use App\Enums\OrderStatus;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * 訂單狀態機（§5.4）：只允許表上列的轉移，而且用條件式 UPDATE。
 * 回傳 false＝狀態已經不是預期的（例如重複的付款成功通知）→ 呼叫端直接忽略，天生冪等。
 */
class OrderTransitions
{
    /** to => 允許的 from */
    private const ALLOWED = [
        'PAID' => ['PENDING_PAYMENT'],
        'PAYMENT_FAILED' => ['PENDING_PAYMENT'],
        'CANCELLED' => ['PENDING_PAYMENT', 'PAID'],
        'FULFILLING' => ['PAID'],
        'COMPLETED' => ['PAID', 'FULFILLING'], // 部分退款的訂單維持 PARTIALLY_REFUNDED（交付進度看卡片）
        'PARTIALLY_REFUNDED' => ['PAID', 'FULFILLING', 'COMPLETED', 'PARTIALLY_REFUNDED'],
        'REFUNDED' => ['PAID', 'FULFILLING', 'COMPLETED', 'PARTIALLY_REFUNDED', 'CANCELLED'],
    ];

    public function __construct(private OrderStageMetrics $stages) {}

    public function transition(int $orderId, OrderStatus $to, array $extra = []): bool
    {
        $from = self::ALLOWED[$to->value] ?? throw new \LogicException("沒有定義轉移到 {$to->value}");

        $ok = DB::table('orders')
            ->where('id', $orderId)
            ->whereIn('status', $from)
            ->update(['status' => $to->value, 'updated_at' => now(), ...$extra]) === 1;

        // 沒命中（狀態已經不是預期的）也要記：重複事件、亂序事件都會走到這裡，除錯時最需要看
        Log::debug($ok ? "order → {$to->value}" : "order → {$to->value} skipped (status not in from)", ['order_id' => $orderId, 'to' => $to->value, 'from' => $from, 'applied' => $ok]);

        if ($ok) {
            $this->stages->record($orderId, strtolower($to->value));   // paid、fulfilling、completed、payment_failed…
        }

        return $ok;
    }
}
