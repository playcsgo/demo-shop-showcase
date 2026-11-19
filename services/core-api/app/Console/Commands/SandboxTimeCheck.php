<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;

/**
 * 時間壓縮之後還合不合理（sandbox 每個情境開始前跑）：
 *   1. 設定出來的時間之間，大小關係還成立（全部同比例縮，正常一定成立；這裡防的是有人只改了其中一個）
 *   2. 縮完最短的逾時，還是「真正做事的時間」的好幾倍：程式處理、DB 不會因為壓縮變快，逾時縮太短就會誤判
 *   3. 只能用整數秒的設定（SQS 可見性逾時、排程間隔、訂閱週期）縮完至少 1 秒
 *
 *   php artisan sandbox:time-check --hold-ttl=120 --hub-timeouts-ms=500,1000 --real-p99-ms=450
 */
class SandboxTimeCheck extends Command
{
    protected $signature = 'sandbox:time-check
        {--hold-ttl=600 : 醫院保留有效秒數（壓縮後，partners 的設定）}
        {--hub-timeouts-ms= : hub 呼叫各廠商的逾時（壓縮後，hub /health 的 timeouts_ms），逗號分隔}
        {--real-p99-ms=500 : 真正做事的時間：完美世界情境 API 回應的 p99}
        {--json}';

    protected $description = '檢查時間壓縮後各項時間是否還合理';

    private const SAFETY = 3;   // 逾時至少是真實處理時間的幾倍

    public function handle(): int
    {
        $c = config('shop');
        $scale = $c['time_scale'];
        $holdTtl = (int) $this->option('hold-ttl');
        $realP99 = (int) $this->option('real-p99-ms');
        $timeouts = array_filter(array_map('intval', explode(',', (string) $this->option('hub-timeouts-ms'))));
        $timeouts[] = (int) round($c['hub_timeout_seconds'] * 1000);
        $shortest = min($timeouts);

        $rules = [
            ['付款期限 > SQS 重試窗口（可見性逾時 × 5 次）', $c['payment_expire_after_seconds'], '>', $c['sqs_retry_window_seconds']],
            ['醫院保留時間 > 結帳時保留至少要剩的時間', $holdTtl, '>', $c['booking']['hold_min_remaining_seconds']],
            ['結帳時保留至少要剩 > 付款期限', $c['booking']['hold_min_remaining_seconds'], '>', $c['payment_expire_after_seconds']],
            ['付款期限 > 開始主動查詢金流的時間', $c['payment_expire_after_seconds'], '>', $c['payment_reconcile_after_seconds']],
            ['開始主動查詢金流的時間 ≥ 對帳排程間隔', $c['payment_reconcile_after_seconds'], '>=', $c['reconcile_every_seconds']],
            ['授權上限 > 卡住多久就重送', $c['booking']['authorization_max_seconds'], '>', $c['booking']['stuck_after_seconds']],
            ['最短的逾時（ms）≥ 真實處理時間 p99 × '.self::SAFETY, $shortest, '>=', $realP99 * self::SAFETY],
        ];
        // 只能用整數秒的設定：原本的秒數 ÷ 倍數 要 ≥ 1，不然會被進位成 1 秒，大小關係就跑掉了
        foreach (['SQS 可見性逾時' => 30, '對帳排程間隔' => 10, '訂閱週期' => (int) env('SUBSCRIPTION_INTERVAL_SECONDS', 5), '訂閱重試間隔' => 5] as $name => $raw) {
            $rules[] = ["{$name}壓縮後 ≥ 1 秒（{$raw} 秒 ÷ {$scale}）", round($raw / $scale, 2), '>=', 1];
        }

        $results = array_map(fn ($r) => [
            'rule' => $r[0], 'left' => $r[1], 'op' => $r[2], 'right' => $r[3],
            'ok' => $r[2] === '>' ? $r[1] > $r[3] : $r[1] >= $r[3],
        ], $rules);
        $ok = collect($results)->every('ok');

        if ($this->option('json')) {
            $this->line(json_encode(['time_scale' => $scale, 'ok' => $ok, 'shortest_timeout_ms' => $shortest, 'real_p99_ms' => $realP99, 'rules' => $results], JSON_UNESCAPED_UNICODE));
        } else {
            $this->info("時間壓縮 ×{$scale}");
            $this->table(['規則', '左', '', '右', '結果'], array_map(fn ($r) => [$r['rule'], $r['left'], $r['op'], $r['right'], $r['ok'] ? '✅' : '❌'], $results));
        }

        return $ok ? self::SUCCESS : self::FAILURE;
    }
}
