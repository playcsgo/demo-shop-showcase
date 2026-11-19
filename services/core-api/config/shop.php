<?php

/**
 * 商店規則（demo 用固定值；正式環境可改由後台設定）
 *
 * 時間壓縮（sandbox，TIME_SCALE）：所有「設定出來的時間」同比例縮——付款期限、預留庫存、保留時段、授權上限、
 * 對帳時機、訂閱週期，也包括呼叫 hub 的逾時、outbox 租約、SQS 可見性逾時。hub、partners 用同一個倍數。
 * 縮不了的只有「真正做事的時間」（程式處理、DB、容器間傳輸），php artisan sandbox:time-check 檢查縮完還夠不夠用。
 */
$scale = max(1.0, (float) env('TIME_SCALE', 1));
$t = fn (int|float $seconds): int => max(1, (int) round($seconds / $scale));   // 整數秒（排程、SQS 只能用整數秒）
$tf = fn (int|float $seconds): float => round($seconds / $scale, 3);             // 可以有小數（HTTP 逾時）

return [
    'time_scale' => $scale,

    // SQS 可見性逾時 30 秒 × 最多收 5 次（infra/localstack/init-aws.sh；sandbox 每個情境開始時依倍數重設）
    // 一則訊息最慢要這麼久才會進 DLQ；付款期限必須比它長，否則訊息還在重試就被判定逾時
    'sqs_visibility_seconds' => $t(30),
    'sqs_retry_window_seconds' => $t(30) * 5,
    // core 呼叫 hub 內部 API（醫院保留時段）的逾時：hub 那邊最多 2 次 × 2.5 秒
    'hub_timeout_seconds' => $tf(6),
    // outbox 租約：relay 拿走訊息後這麼久沒送出，別的 relay 可以接手
    'outbox_lease_seconds' => $t(30),

    // 運費：依包裹計算（§5.4）
    'shipping_fees' => [
        'standard' => 80,
        'litter' => 120,
        'bulky' => 1500,
    ],

    // 金流手續費（萬分比）：由汪支付，依金額比例分攤給供應商明細
    'payment_fee_bps' => 200,

    // 預留庫存逾時（未付款即釋放）
    'reservation_ttl_seconds' => $t(900),

    // 庫存分桶（熱賣模式，InventoryBuckets）：熱門商品的庫存拆成好幾列，同時下單的人分散去鎖不同列
    'inventory' => [
        'hot_buckets' => (int) env('INVENTORY_HOT_BUCKETS', 8),          // 後台勾「熱賣模式」拆成幾桶（壓測量出來的，見 M18）
        'min_per_bucket' => (int) env('INVENTORY_MIN_PER_BUCKET', 20),   // 每桶至少這麼多件可賣才拆：庫存少的商品少拆幾桶，不會零零碎碎
    ],

    // 訂閱（demo 5 秒一期、12 期）
    'subscription' => [
        'interval_seconds' => $t((int) env('SUBSCRIPTION_INTERVAL_SECONDS', 5)),
        'total_cycles' => (int) env('SUBSCRIPTION_TOTAL_CYCLES', 12),
        'retry_backoff_seconds' => array_map($t, [5, 15, 35]),
        'max_consecutive_failures' => 3,
    ],

    // 對帳：PENDING_PAYMENT 超過多久主動查詢金流（demo 2 分鐘）
    'payment_reconcile_after_seconds' => $t((int) env('PAYMENT_RECONCILE_AFTER_SECONDS', 120)),
    // 對帳、重送的指數退避上限：20 → 40 → 80 → 160 → 300 → 300 秒…（金流掛很久時，不要一直打它）
    'payment_reconcile_max_interval_seconds' => $t(300),
    // 對帳排程多久跑一次（routes/console.php）：時間壓縮後要跟著變密
    'reconcile_every_seconds' => $t(10),

    // 只給連線數實驗用：每個 API 請求先在資料庫等 N 毫秒（模擬查詢變慢、連線被佔更久）
    'demo_db_latency_ms' => (int) env('DEMO_DB_LATENCY_MS', 0),

    // 付款期限：超過才可能判定「沒扣款＝失敗」。必須大於 SQS 重試窗口（可見性 30 秒 × 5 次 = 150 秒）
    'payment_expire_after_seconds' => $t((int) env('PAYMENT_EXPIRE_AFTER_SECONDS', 900)),

    // 預約 TCC（§6.4.1）：結帳時保留至少要剩「付款期限＋緩衝」，否則付完款時段可能已過期
    'booking' => [
        'hold_min_remaining_seconds' => $t((int) env('PAYMENT_EXPIRE_AFTER_SECONDS', 900) + 20),
        'stuck_after_seconds' => $t(60),   // 授權後超過這麼久還沒確認／請款／取消 → 對帳重送指令
        'authorization_max_seconds' => $t(300),   // 不變式：授權不能圈住客人的額度超過這麼久
    ],
];
