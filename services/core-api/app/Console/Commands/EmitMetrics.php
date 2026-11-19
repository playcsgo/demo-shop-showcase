<?php

namespace App\Console\Commands;

use App\Domain\Messaging\QueueClient;
use App\Domain\Observability\StatsD;
use App\Domain\Reconciliation\InvariantChecker;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * 業務指標 → Datadog（排程每 10 秒）。
 * APM 看得到「請求慢不慢」，看不到「帳對不對」；這裡補上：不變式、處理中、DLQ 深度、MySQL 連線數。
 */
class EmitMetrics extends Command
{
    protected $signature = 'metrics:emit';

    protected $description = '把不變式、處理中數量、DLQ 深度、MySQL 連線數送到 DogStatsD';

    public function handle(StatsD $statsd, InvariantChecker $checker, QueueClient $queues): int
    {
        foreach (array_values($checker->check()) as $i => $result) {
            $statsd->gauge('demo.invariant.mismatches', $result['count'], ['check' => InvariantChecker::METRIC_TAGS[$i]]);
        }

        foreach ($checker->inFlight() as $name => $count) {
            $statsd->gauge('demo.in_flight', $count, ['kind' => $name]);
        }

        foreach ([...config('messaging.command_queues'), 'integration-events', 'analytics-events'] as $queue) {
            $statsd->gauge('demo.queue.depth', $queues->depth($queue), ['queue' => $queue]);
            $statsd->gauge('demo.queue.depth', $queues->depth("{$queue}-dlq"), ['queue' => "{$queue}-dlq"]);
        }

        // 連線預算（§12.2）：目前連線數 vs 上限
        $status = collect(DB::select("SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Connection_errors_max_connections')"))
            ->pluck('Value', 'Variable_name');
        $statsd->gauge('demo.mysql.threads_connected', (int) $status['Threads_connected']);
        $statsd->gauge('demo.mysql.max_connection_errors', (int) $status['Connection_errors_max_connections']);

        return self::SUCCESS;
    }
}
