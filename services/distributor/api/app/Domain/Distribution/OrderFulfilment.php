<?php

namespace App\Domain\Distribution;

use App\Domain\Catalog\InventoryService;
use App\Domain\DomainException;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderStatus;
use App\Enums\DistributorOrderType;
use App\Models\DistributorBatch;
use App\Models\DistributorOrder;
use App\Models\DistributorOrderEtaChange;
use App\Models\DistributorOrderEvent;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * ETA、出貨、送達，逐張按，都由負責的業務操作。條件式 UPDATE：重複按或兩人同時按，只有一個生效。
 *  - 現貨在「已出貨」才實扣：貨真的離開倉庫，庫存才減少
 *  - 早鳥不動 inventory：貨是為這張單生產的，直接出給它，不進可賣庫存
 *  - 已送達由業務確認：沒有串貨運，系統不知道貨到了沒
 */
class OrderFulfilment
{
    public function __construct(private InventoryService $inventory) {}

    /** ETA 是預計抵達客戶的日期：選填、可以一直改、出貨後也能改（貨在路上也會延遲），送達後才鎖住 */
    public function setEta(DistributorOrder $order, ?string $date, User $by): void
    {
        $this->authorize($by, $order);

        DB::transaction(function () use ($order, $date, $by) {
            $current = DistributorOrder::whereKey($order->id)->whereIn('status', [DistributorOrderStatus::InProgress, DistributorOrderStatus::Shipped])->lockForUpdate()->first();
            if ($current === null) {
                throw new DomainException('order_status_changed', '這張單現在不能改 ETA，請重新整理', 409);
            }
            if ($current->eta_date?->toDateString() === $date) {
                return;
            }
            DistributorOrderEtaChange::create(['order_id' => $order->id, 'before_date' => $current->eta_date, 'after_date' => $date, 'changed_by_user_id' => $by->id]);
            $current->update(['eta_date' => $date]);
        });
    }

    public function ship(DistributorOrder $order, User $by): void
    {
        $this->authorize($by, $order);

        DB::transaction(function () use ($order, $by) {
            $this->transition($order, DistributorOrderStatus::InProgress, DistributorOrderStatus::Shipped, ['shipped_by_user_id' => $by->id, 'shipped_at' => now()]);
            if ($order->batch()->sole()->order_type === DistributorOrderType::Stock) {
                $this->inventory->commit($order->id);
            }
            DistributorOrderEvent::record($order->batch_id, 'ORDER_SHIPPED', $by, orderId: $order->id);
        });
    }

    public function deliver(DistributorOrder $order, User $by): void
    {
        $this->authorize($by, $order);

        DB::transaction(function () use ($order, $by) {
            // 鎖批次：同時按最後兩張單時，後面那個才看得到前面的結果，批次不會卡在處理中
            DistributorBatch::whereKey($order->batch_id)->lockForUpdate()->first();
            $this->transition($order, DistributorOrderStatus::Shipped, DistributorOrderStatus::Delivered, ['delivered_by_user_id' => $by->id, 'delivered_at' => now()]);
            DistributorOrderEvent::record($order->batch_id, 'ORDER_DELIVERED', $by, orderId: $order->id);

            if (! DistributorOrder::where('batch_id', $order->batch_id)->where('status', '!=', DistributorOrderStatus::Delivered)->exists()) {
                DistributorBatch::whereKey($order->batch_id)->where('status', DistributorBatchStatus::Processing)->update(['status' => DistributorBatchStatus::Completed]);
            }
        });
    }

    private function authorize(User $by, DistributorOrder $order): void
    {
        if (! $by->can('fulfil', $order)) {
            throw new DomainException('forbidden', '這不是你負責的經銷商', 403);
        }
    }

    /** @param  array<string, mixed>  $columns */
    private function transition(DistributorOrder $order, DistributorOrderStatus $from, DistributorOrderStatus $to, array $columns): void
    {
        $won = DistributorOrder::whereKey($order->id)->where('status', $from)->update(['status' => $to] + $columns);
        if ($won === 0) {
            throw new DomainException('order_status_changed', '這張單的狀態不對或已經處理過，請重新整理', 409);
        }
    }
}
