<?php

namespace App\Domain\Observability;

use Illuminate\Support\Facades\DB;

/**
 * 訂單走到每個階段時，記下「從下單到這裡花了幾秒」→ Datadog 的 distribution，算出所有訂單的 p50／p95／p99。
 *
 * APM 只看得到單一個請求；一筆訂單從下單、等金流回呼、出貨到送達，跨好幾個服務和佇列，
 * 要看「整筆訂單」每一段花多久，就在 core 處理到每個階段時自己記。
 * stage 的種類是固定的幾個（不能用訂單編號、correlation_id 當 tag：每筆都不一樣，Datadog 會按組合數收費）。
 *
 * 等交易 commit 之後才送：交易回滾的話，這個階段根本沒發生。沒開 Datadog 時什麼都不做（連查詢都不做）。
 */
class OrderStageMetrics
{
    public const METRIC = 'demo.order.stage_seconds';

    public function __construct(private StatsD $statsd) {}

    public function record(int $orderId, string $stage): void
    {
        if (! $this->statsd->enabled()) {
            return;
        }

        DB::afterCommit(function () use ($orderId, $stage) {
            $createdAt = DB::table('orders')->where('id', $orderId)->value('created_at');
            if ($createdAt) {
                $this->statsd->distribution(self::METRIC, now()->diffInMilliseconds($createdAt, true) / 1000, ['stage' => $stage]);
            }
        });
    }
}
