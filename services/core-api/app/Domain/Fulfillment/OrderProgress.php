<?php

namespace App\Domain\Fulfillment;

use App\Domain\Ordering\OrderTransitions;
use App\Enums\OrderStatus;
use Illuminate\Support\Facades\DB;

/**
 * 訂單狀態由「交付單位」推導（§6.5）：
 *  - 每個明細都結束（DONE／REFUNDED／CANCELLED）→ COMPLETED
 *  - 有任何明細開始處理 → FULFILLING
 */
class OrderProgress
{
    public function __construct(private OrderTransitions $transitions) {}

    public function refresh(int $orderId): void
    {
        $statuses = DB::table('order_items')->where('order_id', $orderId)->pluck('fulfillment_status');
        if ($statuses->isEmpty()) {
            return;
        }

        $finished = $statuses->every(fn ($s) => in_array($s, ['DONE', 'REFUNDED', 'CANCELLED'], true));
        if ($finished) {
            $this->transitions->transition($orderId, OrderStatus::Completed);

            return;
        }

        if ($statuses->contains(fn ($s) => in_array($s, ['PROCESSING', 'DONE'], true))) {
            $this->transitions->transition($orderId, OrderStatus::Fulfilling);
        }
    }

    /** 某個明細的所有包裹都送達 → 明細完成 */
    public function markItemsDeliveredFor(int $shipmentId): void
    {
        $itemIds = DB::table('shipment_items')->where('shipment_id', $shipmentId)->whereNotNull('order_item_id')->pluck('order_item_id');

        foreach ($itemIds as $itemId) {
            $pending = DB::table('shipment_items as si')->join('shipments as s', 's.id', '=', 'si.shipment_id')
                ->where('si.order_item_id', $itemId)->where('s.status', '!=', 'DELIVERED')->exists();
            if (! $pending) {
                DB::table('order_items')->where('id', $itemId)->where('fulfillment_status', 'PROCESSING')
                    ->update(['fulfillment_status' => 'DONE', 'updated_at' => now()]);
            }
        }
    }
}
