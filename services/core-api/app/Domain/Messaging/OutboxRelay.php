<?php

namespace App\Domain\Messaging;

use App\Domain\Observability\PipelineMetrics;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Outbox 發送程序（§5.8）。分三步，**呼叫 SQS 不在交易內**（§12.2：交易內不呼叫外部服務）：
 *  1. 認領（短交易）：FOR UPDATE SKIP LOCKED 拿一批 PENDING，把 available_at 往後推（租約 30 秒）
 *  2. 送出（交易外）：sendMessageBatch
 *  3. 標記：送成功的標 SENT
 * 送失敗或程序當機 → 租約到期後自動重送 → 至少一次送達（at-least-once），消費端靠 inbox 去重。
 * 開多個 relay 也安全：SKIP LOCKED 讓各自拿不同的列。
 */
class OutboxRelay
{
    private const LEASE_SECONDS = 30;

    public function __construct(private QueueClient $queue, private PipelineMetrics $metrics) {}

    /** @return int 這次送出的數量 */
    public function relayOnce(): int
    {
        $started = microtime(true);
        $rows = $this->claim(config('messaging.relay.batch_size'));
        if ($rows->isEmpty()) {
            return 0;
        }

        $sentIds = [];
        foreach ($rows->groupBy('queue') as $queue => $group) {
            try {
                $ok = $this->queue->sendBatch($queue, $group->map(fn ($r) => ['id' => (string) $r->id, 'body' => $r->payload])->values()->all());
                $sentIds = [...$sentIds, ...array_map('intval', $ok)];
            } catch (\Throwable $e) {
                Log::warning('outbox relay: send failed, will retry after lease', ['queue' => $queue, 'error' => $e->getMessage()]);
            }
        }

        if ($sentIds) {
            DB::table('outbox_messages')->whereIn('id', $sentIds)->update(['status' => 'SENT', 'sent_at' => now(), 'updated_at' => now()]);
            // 處理時間：撈出來 → 送進 SQS → 標記完成（同一批的每一則都算這一批的時間）
            foreach ($rows->whereIn('id', $sentIds) as $row) {
                $this->metrics->handled("core-relay.{$row->type}", $started);
            }
        }

        if ($sentIds) {
            Log::debug('outbox relayed', ['sent' => count($sentIds)]);
        }

        return count($sentIds);
    }

    /** 短交易：認領一批，租約期間其他 relay 不會再拿到 */
    private function claim(int $limit)
    {
        return DB::transaction(function () use ($limit) {
            $rows = DB::table('outbox_messages')
                ->where('status', 'PENDING')->where('available_at', '<=', now())
                ->orderBy('id')->limit($limit)
                ->lock('for update skip locked') // 多個 relay 各拿各的，不互等
                ->get();

            if ($rows->isNotEmpty()) {
                DB::table('outbox_messages')->whereIn('id', $rows->pluck('id'))->update([
                    'available_at' => now()->addSeconds((int) config('shop.outbox_lease_seconds', self::LEASE_SECONDS)),
                    'attempts' => DB::raw('attempts + 1'),
                    'updated_at' => now(),
                ]);
            }

            return $rows;
        });
    }
}
