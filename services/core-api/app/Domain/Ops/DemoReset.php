<?php

namespace App\Domain\Ops;

use App\Domain\Messaging\QueueClient;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Redis;

/**
 * demo 用「清空所有資料」（容器不動）：做的事和 sandbox 每個情境開始前的重置一樣（sandbox/lib/sets.mjs 的 reset）。
 *   1. 暫停背景程式（relay、worker、scheduler 看到 Redis 的暫停旗標就先不動）
 *   2. 清空所有 SQS 佇列（含 DLQ）
 *   3. 資料庫重建＋種子資料（migrate:fresh --seed）
 *   4. partners 清掉設定和事件紀錄
 *   5. Redis FLUSHALL（session、快取、鎖、hub 的去重鍵；暫停旗標也一起清掉 → 背景程式恢復）
 * sandbox 是直接停容器；這裡在容器裡面執行，停不了別的容器，所以改用旗標讓背景程式自己暫停。
 * 正式環境不能用（allowed()）。
 */
class DemoReset
{
    public const PAUSE_KEY = 'demo:reset:paused';

    public function __construct(private QueueClient $queue) {}

    public static function allowed(): bool
    {
        return ! app()->isProduction();
    }

    public static function paused(): bool
    {
        try {
            return (bool) Cache::get(self::PAUSE_KEY);
        } catch (\Throwable) {
            return false;   // Redis 連不上時不擋住背景程式
        }
    }

    /**
     * 後台按鈕用：在背景執行（整個流程可能超過 PHP-FPM 的 30 秒逾時）。
     * 輸出寫到 storage/logs/demo-reset.log：PHP-FPM 是 www-data 身分，寫不進容器的 stderr（/proc/1/fd/2 是 root 的）
     */
    public static function startInBackground(): void
    {
        Process::path(base_path())->run('nohup php artisan demo:reset >> storage/logs/demo-reset.log 2>&1 &');
    }

    /** 所有佇列（和 infra/localstack/queues.txt 同一份清單）＋各自的 DLQ */
    public static function queues(): array
    {
        $queues = [...config('messaging.command_queues'), config('messaging.consume_queue'), 'analytics-events'];

        return [...$queues, ...array_map(fn ($q) => "{$q}-dlq", $queues)];
    }

    /** @param  callable(string): void  $log */
    public function run(callable $log, int $settleSeconds = 2): void
    {
        Cache::put(self::PAUSE_KEY, true, 300);   // 5 分鐘後自動失效：就算中途當掉，背景程式也不會永遠停著
        $log('暫停背景程式');
        sleep($settleSeconds);                    // 讓手上正在處理的那一則做完

        try {
            foreach (self::queues() as $q) {
                $this->queue->purge($q);
            }
            $log('清空 SQS：'.count(self::queues()).' 條佇列（含 DLQ）');

            Artisan::call('migrate:fresh', ['--seed' => true, '--force' => true]);
            $log('資料庫重建＋種子資料');

            try {
                Http::timeout(5)->post(rtrim(config('services.partners.url'), '/').'/admin/reset')->throw();
                $log('partners 重設');
            } catch (\Throwable $e) {
                $log('partners 重設失敗（略過）：'.$e->getMessage());
            }
        } finally {
            Cache::forget(self::PAUSE_KEY);       // 快取不一定在預設的 Redis 連線上：明確解除暫停
            Redis::connection()->flushall();
            $log('清空 Redis，背景程式恢復');
        }
    }
}
