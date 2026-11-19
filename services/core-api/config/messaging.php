<?php

/**
 * 服務之間的佇列（system-design §3.3）
 */
return [
    'sqs' => [
        'region' => env('AWS_DEFAULT_REGION', 'ap-northeast-1'),
        'endpoint' => env('AWS_ENDPOINT'),          // LocalStack；上雲時不設
        'prefix' => env('SQS_PREFIX'),              // queue URL 前綴
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
    ],

    // core 送出的指令、core 接收的事件
    'publish_queue' => 'core-commands',
    'consume_queue' => 'integration-events',

    // 指令依「打哪個廠商」分到各自的佇列（壓測發現：全部擠在一條、共用 worker，一個廠商慢就拖累全部）
    //   hub 每條佇列配一個池子，大小依那個廠商的延遲決定；K8s 上每條佇列可以各自擴充（KEDA 看排隊數量）
    //   金流的對帳查詢另外一條、池子較小：它是補救用的，不能和新的付款請求搶資源
    // 沒列在這裡的指令照舊送 core-commands
    'command_routes' => [
        'payment.requested' => 'payment-commands',
        'payment.capture.requested' => 'payment-commands',
        'payment.void.requested' => 'payment-commands',
        'refund.requested' => 'payment-commands',
        'payment.reconcile.requested' => 'payment-reconcile-commands',
        'shipment.requested' => 'logistics-commands',
        'booking.confirm.requested' => 'clinic-commands',
        'booking.release.requested' => 'clinic-commands',
        'notification.requested' => 'line-commands',
    ],
    // 所有指令佇列（指標、監控用）
    'command_queues' => ['core-commands', 'payment-commands', 'payment-reconcile-commands', 'logistics-commands', 'clinic-commands', 'line-commands'],

    'relay' => [
        'batch_size' => 10,                         // SQS 一次最多送 10 則
        'idle_sleep_ms' => 200,
        'retry_backoff_seconds' => [1, 5, 15, 60],
    ],
];
