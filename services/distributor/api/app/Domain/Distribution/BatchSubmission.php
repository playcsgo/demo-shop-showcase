<?php

namespace App\Domain\Distribution;

use App\Domain\Catalog\InventoryService;
use App\Domain\DomainException;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderStatus;
use App\Enums\DistributorOrderType;
use App\Enums\ReservationStatus;
use App\Models\DistributorBatch;
use App\Models\DistributorBatchRevision;
use App\Models\DistributorOrder;
use App\Models\DistributorOrderEvent;
use App\Models\DistributorUser;
use App\Models\InventoryReservation;
use Carbon\CarbonImmutable;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** 送出一批：全部在同一個交易，任何一步失敗整批退回 */
class BatchSubmission
{
    public function __construct(private BatchPricer $pricer, private InventoryService $inventory) {}

    /**
     * 同一個 key 重送回原本的批次（靠批次表的唯一鍵）
     * 兩個同時送：後到的卡在 UNIQUE 上，等先到的 commit 後撞鍵，再查出那一批
     *
     * @param  array<string, mixed>  $input
     */
    public function submit(DistributorUser $by, array $input, string $requestKey): DistributorBatch
    {
        $existing = fn () => DistributorBatch::where('distributor_id', $by->distributor_id)->where('request_key', $requestKey)->first();
        if ($batch = $existing()) {
            return $batch;
        }

        try {
            return DB::transaction(function () use ($by, $input, $requestKey) {
                $priced = $this->pricer->price($by->loadMissing('distributor')->distributor, $input);
                $submittedAt = now();

                $batch = DistributorBatch::create([
                    'batch_no' => 'B'.$this->stamp(), 'distributor_id' => $by->distributor_id,
                    'submitted_by_user_id' => $by->id, 'request_key' => $requestKey, 'revision' => 1,
                ] + $this->batchColumns($priced, $submittedAt));

                $this->createOrders($batch, $priced);
                $this->reserve($batch, $priced);
                $this->recordRevision($batch, $priced, $by, $submittedAt);
                DistributorOrderEvent::record($batch->id, 'SUBMITTED', $by);

                return $batch;
            });
        } catch (UniqueConstraintViolationException $e) {
            return $existing() ?? throw $e;
        }
    }

    /**
     * 退回後重送：價格、早鳥資格、警告全部重算，還在的 shop 沿用原本的單和單號。
     * 任何一步失敗整個退回，批次維持 REJECTED，舊內容都還在
     *
     * @param  array<string, mixed>  $input
     */
    public function resubmit(DistributorUser $by, DistributorBatch $batch, array $input): DistributorBatch
    {
        return DB::transaction(function () use ($by, $batch, $input) {
            $priced = $this->pricer->price($by->loadMissing('distributor')->distributor, $input);
            $submittedAt = now();

            // 條件式 UPDATE：重複送、同時送，只有一個搶得到
            $won = DistributorBatch::whereKey($batch->id)->where('status', DistributorBatchStatus::Rejected)->update(
                $this->batchColumns($priced, $submittedAt) + [
                    'revision' => $batch->revision + 1, 'submitted_by_user_id' => $by->id,
                    'reviewed_by_user_id' => null, 'reviewed_at' => null,
                ]
            );
            if ($won === 0) {
                throw new DomainException('batch_status_changed', '只有已退回的批次可以重新送出', 409);
            }
            $fresh = DistributorBatch::findOrFail($batch->id);

            // 退回時預留都已釋放：不留著的話，重新預留會撞 UNIQUE(distributor_order_id, product_id, bucket_no)。歷史看版本快照
            InventoryReservation::whereIn('distributor_order_id', $fresh->orders()->pluck('id'))->where('status', ReservationStatus::Released)->delete();
            $this->replaceOrders($fresh, $priced);
            $this->reserve($fresh, $priced);
            $this->recordRevision($fresh, $priced, $by, $submittedAt);
            DistributorOrderEvent::record($fresh->id, 'RESUBMITTED', $by);

            return $fresh;
        });
    }

    /** @param  array<string, mixed>  $priced */
    private function replaceOrders(DistributorBatch $batch, array $priced): void
    {
        $existing = $batch->orders()->get()->keyBy('shop_id');
        $keep = array_column($priced['orders'], 'shop_id');

        // 被拿掉的 shop：刪除該單，明細跟著刪，事件的 order_id 變成 NULL
        // 不能用 except：Eloquent Collection 的 except 比的是主鍵，不是 keyBy 的 shop_id
        DistributorOrder::whereIn('id', $existing->whereNotIn('shop_id', $keep)->pluck('id'))->delete();

        foreach ($priced['orders'] as $o) {
            $order = $existing->get($o['shop_id']);
            if (! $order) {
                $this->createOrders($batch, ['orders' => [$o]]);

                continue;
            }
            $order->update(['requested_ship_date' => $o['requested_ship_date'], 'subtotal_minor' => $o['subtotal_minor']]);
            $order->items()->delete();
            $order->items()->createMany($this->itemRows($o['items']));
        }
    }

    /**
     * 批次上跟著每次送出變動的欄位
     *
     * @param  array<string, mixed>  $priced
     * @return array<string, mixed>
     */
    private function batchColumns(array $priced, \DateTimeInterface $submittedAt): array
    {
        $today = CarbonImmutable::now(BatchPricer::BUSINESS_TIMEZONE)->startOfDay();

        return collect($priced)->only('contract_id', 'order_type', 'currency', 'total_minor', 'prepay_bps', 'prepay_minor', 'warnings', 'moq_results')->all() + [
            'status' => DistributorBatchStatus::InReview,
            'submitted_at' => $submittedAt,
            'anticipated_response_date' => WorkingDays::add($today, 2)->toDateString(),
        ];
    }

    /** @param  array<string, mixed>  $priced */
    private function createOrders(DistributorBatch $batch, array $priced): void
    {
        foreach ($priced['orders'] as $o) {
            $order = $batch->orders()->create([
                'order_no' => 'D'.$this->stamp(), 'shop_id' => $o['shop_id'], 'status' => DistributorOrderStatus::Pending,
                'requested_ship_date' => $o['requested_ship_date'], 'subtotal_minor' => $o['subtotal_minor'],
            ]);
            $order->items()->createMany($this->itemRows($o['items']));
        }
    }

    /**
     * @param  array<int, array<string, mixed>>  $items
     * @return array<int, array<string, mixed>>
     */
    private function itemRows(array $items): array
    {
        return array_map(fn (array $i) => collect($i)->only('product_id', 'qty_cases', 'case_size', 'qty_units', 'unit_price_minor', 'amount_minor', 'hs_code')->all(), $items);
    }

    /**
     * 現貨才預留。依 product_id 排序：兩批要同樣的兩個 SKU 時，一定先搶同一個，不會互相等待
     *
     * @param  array<string, mixed>  $priced
     */
    private function reserve(DistributorBatch $batch, array $priced): void
    {
        if ($priced['order_type'] !== DistributorOrderType::Stock->value) {
            return;
        }

        $orderIds = $batch->orders()->pluck('id', 'shop_id');
        $lines = collect($priced['orders'])->flatMap(fn (array $o) => array_map(fn (array $i) => ['order_id' => $orderIds[$o['shop_id']]] + $i, $o['items']))
            ->sortBy([['product_id', 'asc'], ['order_id', 'asc']]);

        foreach ($lines as $line) {
            try {
                $this->inventory->reserve($line['order_id'], $line['product_id'], $line['qty_units']);
            } catch (DomainException $e) {
                if ($e->reason !== 'insufficient_stock') {
                    throw $e;
                }
                throw new DomainException('insufficient_stock', "{$line['sku']} 庫存不足，可以減少數量或改下早鳥單", 409, ['sku' => $line['sku']]);
            }
        }
    }

    /** @param  array<string, mixed>  $priced */
    private function recordRevision(DistributorBatch $batch, array $priced, DistributorUser $by, \DateTimeInterface $submittedAt): void
    {
        DistributorBatchRevision::create([
            'batch_id' => $batch->id, 'revision' => $batch->revision, 'snapshot' => $priced,
            'submitted_by_user_id' => $by->id, 'submitted_at' => $submittedAt,
        ]);
    }

    private function stamp(): string
    {
        return now(BatchPricer::BUSINESS_TIMEZONE)->format('ymd').strtoupper(Str::random(7));
    }
}
