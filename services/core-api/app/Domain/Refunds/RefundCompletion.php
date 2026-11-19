<?php

namespace App\Domain\Refunds;

use App\Domain\Catalog\InventoryService;
use App\Domain\Fulfillment\OrderProgress;
use App\Domain\Ordering\OrderTransitions;
use App\Domain\Settlement\SettlementRecorder;
use App\Domain\Warehouse\WarehouseService;
use App\Enums\FulfillmentType;
use App\Enums\OrderStatus;
use App\Models\Refund;
use Illuminate\Support\Facades\DB;

/**
 * 退款結果（refund.succeeded／refund.failed）
 * 成功：結算分錄回沖、未出貨的直送商品回補庫存、寄倉扣回、明細與訂單狀態更新
 * 失敗：把申請時佔住的數量與金額還回去，讓客服可以重新發起
 */
class RefundCompletion
{
    public function __construct(
        private SettlementRecorder $settlement,
        private InventoryService $inventory,
        private WarehouseService $warehouse,
        private OrderTransitions $transitions,
        private OrderProgress $progress,
    ) {}

    public function succeeded(array $p): void
    {
        DB::transaction(function () use ($p) {
            $changed = DB::table('refunds')->where('id', $p['refund_id'])->where('status', 'PENDING')->update([
                'status' => 'SUCCEEDED', 'provider_refund_id' => $p['provider_refund_id'], 'succeeded_at' => now(), 'updated_at' => now(),
            ]);
            if ($changed === 0) {
                return;
            }

            $refund = Refund::with('items.orderItem', 'order')->find($p['refund_id']);
            foreach ($refund->items as $ri) {
                $item = $ri->orderItem;
                $this->settlement->recordRefund($ri);

                if ($item->fulfillment_type === FulfillmentType::Warehouse) {
                    $this->warehouse->reverseDeposit($refund->order->customer_id, $item->variant_id, $ri->qty, 'refund_item', $ri->id, "refund:{$ri->id}");
                } elseif ($item->fulfillment_type === FulfillmentType::Direct && $item->fulfillment_status->value === 'PENDING') {
                    $this->inventory->restock($item->variant_id, $ri->qty);
                }

                if ($item->fresh()->refundableQty() === 0) {
                    DB::table('order_items')->where('id', $item->id)->update(['fulfillment_status' => 'REFUNDED', 'updated_at' => now()]);
                }
            }

            $allRefunded = DB::table('order_items')->where('order_id', $refund->order_id)->whereColumn('refunded_qty', '<', 'qty')->doesntExist();
            $this->transitions->transition($refund->order_id, $allRefunded ? OrderStatus::Refunded : OrderStatus::PartiallyRefunded);
            $this->progress->refresh($refund->order_id);
        });
    }

    public function failed(array $p): void
    {
        DB::transaction(function () use ($p) {
            $changed = DB::table('refunds')->where('id', $p['refund_id'])->where('status', 'PENDING')->update(['status' => 'FAILED', 'updated_at' => now()]);
            if ($changed === 0) {
                return;
            }

            $refund = Refund::with('items')->find($p['refund_id']);
            foreach ($refund->items as $ri) {
                DB::update('UPDATE order_items SET refunded_qty = refunded_qty - ? WHERE id = ?', [$ri->qty, $ri->order_item_id]);
            }
            DB::update('UPDATE payments SET refunded_amount = refunded_amount - ? WHERE id = ?', [$refund->amount, $refund->payment_id]);
        });
    }
}
