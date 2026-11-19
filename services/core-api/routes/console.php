<?php

use App\Domain\Ops\DemoReset;
use Illuminate\Support\Facades\Schedule;

/*
 * 排程（core-scheduler 容器執行 php artisan schedule:work）
 * onOneServer()：多個 scheduler 同時跑時，用 Redis 鎖保證只有一個執行（§12.1：排程只在一處跑）
 * withoutOverlapping()：上一輪還沒跑完就不啟動下一輪
 * skip(DemoReset::paused())：demo 清空資料時暫停（資料表正在重建）
 */
// appendOutputTo：排程指令預設把輸出丟到 /dev/null，它們寫的 log 會消失 → 接回容器的 stderr（M14）
Schedule::command('subscriptions:run')->everySecond()->onOneServer()->withoutOverlapping()->skip(fn () => DemoReset::paused())->appendOutputTo('/proc/1/fd/2');
// 時間壓縮時跟著變密（config/shop.php 的 reconcile_every_seconds）
$reconcileEvery = (int) config('shop.reconcile_every_seconds');
Schedule::command('payments:reconcile')->{match (true) {
    $reconcileEvery <= 1 => 'everySecond', $reconcileEvery <= 2 => 'everyTwoSeconds', $reconcileEvery <= 5 => 'everyFiveSeconds', default => 'everyTenSeconds'
}}()->onOneServer()->withoutOverlapping()->skip(fn () => DemoReset::paused())->appendOutputTo('/proc/1/fd/2');

// 業務指標 → Datadog（沒有 Agent 時 StatsD 什麼都不做）
Schedule::command('metrics:emit')->everyTenSeconds()->onOneServer()->withoutOverlapping()->skip(fn () => DemoReset::paused())->appendOutputTo('/proc/1/fd/2');

// 庫存分桶：依想要的桶數拆／併、平衡（InventoryBuckets）；後台改了熱賣模式，5 秒內生效、不用重新部署
Schedule::command('inventory:buckets')->everyFiveSeconds()->onOneServer()->withoutOverlapping()->skip(fn () => DemoReset::paused())->appendOutputTo('/proc/1/fd/2');
