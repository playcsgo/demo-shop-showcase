<?php

namespace App\Domain\Shipping;

use App\Domain\Fulfillment\OrderProgress;
use App\Domain\Observability\OrderStageMetrics;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * 物流狀態回報（shipment.status_changed）。
 * callback 可能重複、可能亂序：
 *  - provider_event_id 唯一 → 同一個事件只記一次
 *  - 只有比 last_event_at 新、而且狀態不倒退的事件才會更新包裹狀態（晚到的舊狀態不覆蓋新狀態）
 */
class ShipmentStatusHandler
{
    private const RANK = ['REQUESTED' => 0, 'PICKED_UP' => 1, 'IN_TRANSIT' => 2, 'DELIVERED' => 3, 'FAILED' => 3];

    public function __construct(private OrderProgress $progress, private OrderStageMetrics $stages) {}

    public function handle(array $p): void
    {
        DB::transaction(function () use ($p) {
            $shipment = DB::table('shipments')->where('id', $p['shipment_id'])->lockForUpdate()->first();
            if (! $shipment) {
                throw new \RuntimeException("shipment {$p['shipment_id']} 不存在");
            }

            $inserted = DB::table('shipment_events')->insertOrIgnore([
                'shipment_id' => $shipment->id, 'status' => $p['status'], 'occurred_at' => $p['occurred_at'],
                'provider_event_id' => $p['provider_event_id'], 'created_at' => now(),
            ]);
            if ($inserted === 0) {
                Log::debug('shipment event duplicate, ignored', ['shipment_id' => $shipment->id, 'status' => $p['status'], 'provider_event_id' => $p['provider_event_id']]);

                return; // 重複的 callback
            }

            $occurredAt = Carbon::parse($p['occurred_at']);
            $isNewer = $shipment->last_event_at === null || $occurredAt->gt($shipment->last_event_at);
            $notBackwards = self::RANK[$p['status']] >= self::RANK[$shipment->status];
            if (! ($isNewer && $notBackwards)) {
                Log::info('shipment status out of order, recorded but not applied', ['shipment_id' => $shipment->id, 'current' => $shipment->status, 'incoming' => $p['status'], 'occurred_at' => $p['occurred_at']]);

                return; // 晚到的舊狀態：只記事件，不改包裹狀態
            }
            Log::debug("shipment → {$p['status']}", ['shipment_id' => $shipment->id, 'from' => $shipment->status]);

            DB::table('shipments')->where('id', $shipment->id)->update(array_filter([
                'status' => $p['status'], 'last_event_at' => $occurredAt, 'updated_at' => now(),
                'tracking_no' => $p['tracking_no'] ?? null,
            ]));

            if ($p['status'] === 'DELIVERED') {
                if ($shipment->withdrawal_id) {
                    DB::table('withdrawals')->where('id', $shipment->withdrawal_id)->update(['status' => 'DONE', 'updated_at' => now()]);
                }
                if ($shipment->order_id) {
                    $this->stages->record($shipment->order_id, 'shipment_delivered');
                    $this->progress->markItemsDeliveredFor($shipment->id);
                    $this->progress->refresh($shipment->order_id);
                }
            } elseif ($shipment->withdrawal_id) {
                DB::table('withdrawals')->where('id', $shipment->withdrawal_id)->where('status', 'REQUESTED')->update(['status' => 'SHIPPING', 'updated_at' => now()]);
            }
        });
    }
}
