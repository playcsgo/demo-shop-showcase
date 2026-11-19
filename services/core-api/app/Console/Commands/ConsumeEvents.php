<?php

namespace App\Console\Commands;

use App\Domain\Messaging\EventRouter;
use App\Domain\Ops\DemoReset;
use App\Domain\Observability\PipelineMetrics;
use App\Domain\Messaging\QueueClient;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * 常駐程序：消費 integration-events（core-worker 容器）。
 * 處理成功才刪訊息；失敗不刪 → SQS 可見性逾時後重送 → 失敗 5 次進 DLQ（redrive policy）。
 */
class ConsumeEvents extends Command
{
    protected $signature = 'events:consume {--once : 只收一輪}';

    protected $description = '消費 integration-events 佇列';

    private bool $running = true;

    public function handle(QueueClient $queue, EventRouter $router, PipelineMetrics $metrics): int
    {
        $this->trap([SIGTERM, SIGINT], fn () => $this->running = false);
        $name = config('messaging.consume_queue');

        do {
            if (DemoReset::paused()) {   // demo 清空資料中：不收訊息、不碰資料庫
                sleep(1);
                continue;
            }
            foreach ($queue->receive($name, 10, $this->option('once') ? 1 : 10) as $msg) {
                if (DemoReset::paused()) {   // 等訊息的時候開始清空：不處理（佇列會被清掉）
                    break;
                }
                $started = microtime(true);
                $envelope = json_decode($msg['body'], true);
                $context = ['event_id' => $envelope['event_id'] ?? null, 'type' => $envelope['type'] ?? null,
                    'correlation_id' => $envelope['correlation_id'] ?? null, 'receive_count' => $msg['receive_count'],
                    'order_no' => $envelope['payload']['order_no'] ?? null];
                // 常駐程序：每則訊息換一組 context，處理過程中所有 log（狀態轉移、補償）都自動帶上
                Log::withoutContext();
                Log::withContext(array_filter($context));

                try {
                    $handled = $router->route($envelope);
                    $queue->delete($name, $msg['receipt']);
                    $metrics->handled("core-worker.{$context['type']}", $started);   // 處理時間：開始處理 → 處理完、刪掉訊息
                    Log::info($handled ? "event {$context['type']} handled" : "event {$context['type']} duplicate, skipped (inbox)");
                } catch (\Throwable $e) {
                    Log::error("event {$context['type']} failed, SQS will redeliver", ['error' => $e->getMessage(), 'exception' => $e::class]);
                }
            }
        } while ($this->running && ! $this->option('once'));

        return self::SUCCESS;
    }
}
