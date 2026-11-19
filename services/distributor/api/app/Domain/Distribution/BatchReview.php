<?php

namespace App\Domain\Distribution;

use App\Domain\Catalog\InventoryService;
use App\Domain\DomainException;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderStatus;
use App\Enums\DistributorOrderType;
use App\Models\DistributorBatch;
use App\Models\DistributorBatchRevision;
use App\Models\DistributorOrder;
use App\Models\DistributorOrderEvent;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * 業務的動作都放這裡，不寫在 Filament：可以直接測試，之後換介面也不用改規則。
 * 狀態轉換都用條件式 UPDATE：重複按或兩人同時按，只有一個生效；搶到的才去動庫存和記事件
 */
class BatchReview
{
    public function __construct(private InventoryService $inventory) {}

    public function approve(DistributorBatch $batch, User $by): void
    {
        $this->authorize($batch, $by);

        DB::transaction(function () use ($batch, $by) {
            $to = $batch->prepay_bps > 0 ? DistributorBatchStatus::AwaitingPayment : DistributorBatchStatus::AwaitingStart;
            $this->transition($batch, DistributorBatchStatus::InReview, $to, ['reviewed_by_user_id' => $by->id, 'reviewed_at' => now(), 'approved_at' => now()]);
            DistributorOrderEvent::record($batch->id, 'APPROVED', $by);
        });
    }

    public function reject(DistributorBatch $batch, User $by, string $reason): void
    {
        $this->authorize($batch, $by);
        $reason = trim($reason);
        if ($reason === '') {
            throw new DomainException('reject_reason_required', '退回一定要寫原因');
        }

        DB::transaction(function () use ($batch, $by, $reason) {
            $this->transition($batch, DistributorBatchStatus::InReview, DistributorBatchStatus::Rejected, ['reviewed_by_user_id' => $by->id, 'reviewed_at' => now()]);
            $this->releaseReservations($batch);
            DistributorBatchRevision::where('batch_id', $batch->id)->where('revision', $batch->fresh()->revision)
                ->update(['reject_reason' => $reason, 'rejected_by_user_id' => $by->id, 'rejected_at' => now()]);
            DistributorOrderEvent::record($batch->id, 'REJECTED', $by, $reason);
        });
    }

    /** 預付 0% 沒有收款這一步，要業務按了才開始 */
    public function start(DistributorBatch $batch, User $by): void
    {
        $this->authorize($batch, $by);

        DB::transaction(function () use ($batch, $by) {
            $this->transition($batch, DistributorBatchStatus::AwaitingStart, DistributorBatchStatus::Processing, []);
            DistributorOrderEvent::record($batch->id, 'FULFILMENT_STARTED', $by);
            $this->startFulfilment($batch);
        });
    }

    /** 業務線下確認入帳後按：只記誰、何時按，不記金額，不串金流 */
    public function confirmPayment(DistributorBatch $batch, User $by): void
    {
        $this->authorize($batch, $by);

        DB::transaction(function () use ($batch, $by) {
            $this->transition($batch, DistributorBatchStatus::AwaitingPayment, DistributorBatchStatus::Processing, ['payment_confirmed_by_user_id' => $by->id, 'payment_confirmed_at' => now()]);
            DistributorOrderEvent::record($batch->id, 'PAYMENT_CONFIRMED', $by);
            $this->startFulfilment($batch);
        });
    }

    /** 開始履行前可以取消；之後不能取消，這階段刻意不做 */
    public function cancel(DistributorBatch $batch, User $by): void
    {
        $this->authorize($batch, $by);

        DB::transaction(function () use ($batch, $by) {
            $this->transition($batch, $batch->status === DistributorBatchStatus::AwaitingStart ? DistributorBatchStatus::AwaitingStart : DistributorBatchStatus::AwaitingPayment, DistributorBatchStatus::Cancelled, ['cancelled_by_user_id' => $by->id, 'cancelled_at' => now()]);
            $this->releaseReservations($batch);
            DistributorOrderEvent::record($batch->id, 'CANCELLED', $by);
        });
    }

    /** 畫面藏按鈕不夠：Domain 也檢查是不是負責的業務 */
    private function authorize(DistributorBatch $batch, User $by): void
    {
        if (! $by->can('review', $batch)) {
            throw new DomainException('forbidden', '這不是你負責的經銷商', 403);
        }
    }

    /** @param  array<string, mixed>  $columns */
    private function transition(DistributorBatch $batch, DistributorBatchStatus $from, DistributorBatchStatus $to, array $columns): void
    {
        $won = DistributorBatch::whereKey($batch->id)->where('status', $from)->update(['status' => $to] + $columns);
        if ($won === 0) {
            throw new DomainException('batch_status_changed', '這一批的狀態已經變了，請重新整理', 409);
        }
    }

    private function releaseReservations(DistributorBatch $batch): void
    {
        foreach ($batch->orders()->orderBy('id')->pluck('id') as $orderId) {
            $this->inventory->release($orderId);
        }
    }

    /** 現貨和早鳥都進入 IN_PROGRESS；差別只在顯示的文字和有沒有上看板 */
    private function startFulfilment(DistributorBatch $batch): void
    {
        DistributorOrder::where('batch_id', $batch->id)->where('status', DistributorOrderStatus::Pending)->update(['status' => DistributorOrderStatus::InProgress]);
    }
}
