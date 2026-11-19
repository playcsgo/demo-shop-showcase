<?php

namespace App\Domain\Observability;

/**
 * 每個服務「收到 → 做完」花了幾毫秒 → Datadog 的 distribution（demo.pipeline.handle_ms），算出 p50／p90／p99。
 * 量的是這個服務自己的處理時間：程式本身＋它查資料庫、Redis 的時間；不含服務之間的佇列和網路。
 *
 * step 標籤是「服務.做什麼」（例如 core-api.post.checkout、hub.payment.requested），種類固定（API 路由、訊息類型），不能放訂單編號（每筆都不一樣，Datadog 按組合數收費）。
 * hub 也送同一個指標（services/hub/src/common/metrics.ts），Datadog 上用 step 區分。沒開 Datadog 時什麼都不做。
 */
class PipelineMetrics
{
    public const METRIC = 'demo.pipeline.handle_ms';

    public function __construct(private StatsD $statsd) {}

    /** @param  float  $startedAt  microtime(true) */
    public function handled(string $step, float $startedAt): void
    {
        $this->statsd->distribution(self::METRIC, round((microtime(true) - $startedAt) * 1000, 1), ['step' => $step]);
    }

    /**
     * 這個請求什麼時候到的（microtime 秒）：nginx 收到的時間（X-Request-Start: t=秒.毫秒，見 docker/nginx.conf），
     * 含等 FPM 有空的 worker；沒有這個 header（直接打 FPM）就用 PHP 開始執行的時間。
     * 常駐程序（排程續訂也會下單）不是請求 → null：程序開始的時間跟這筆訂單無關
     * 從 Request 物件讀，不讀 $_SERVER：Octane 的 worker 常駐，$_SERVER 是程序啟動時的值，不會每個請求換
     */
    public static function requestStart(): ?float
    {
        $request = app()->bound('request') ? app('request') : null;
        $header = (string) $request?->header('X-Request-Start');
        if (preg_match('/^t=(\d+(?:\.\d+)?)$/', $header, $m)) {
            return (float) $m[1];
        }
        if (PHP_SAPI === 'cli' && empty($_SERVER['LARAVEL_OCTANE'])) {   // Octane 也是 cli 程序，啟動時會設 LARAVEL_OCTANE
            return null;
        }

        return (float) ($request?->server('REQUEST_TIME_FLOAT') ?? microtime(true));
    }
}
