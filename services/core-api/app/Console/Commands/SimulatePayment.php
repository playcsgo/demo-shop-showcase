<?php

namespace App\Console\Commands;

use App\Domain\Payments\PaymentResultHandler;
use App\Models\Order;
use Illuminate\Console\Command;
use Illuminate\Support\Str;

/**
 * 開發用：在 hub 和 mock 金流接上之前（M5～M7），手動模擬付款結果。
 * 走的是和正式流程同一個 PaymentResultHandler。
 */
class SimulatePayment extends Command
{
    protected $signature = 'dev:pay {order_no} {--fail : 模擬付款失敗}';

    protected $description = '模擬金流付款結果（開發用）';

    public function handle(PaymentResultHandler $handler): int
    {
        $order = Order::where('order_no', $this->argument('order_no'))->firstOrFail();

        $changed = $this->option('fail')
            ? $handler->failed($order->order_no, 'simulated')
            : $handler->succeeded($order->order_no, 'txn_'.Str::random(12), $order->total);

        $this->info($changed ? "訂單 {$order->order_no} → ".$order->fresh()->status->value : '已處理過，略過（冪等）');

        return self::SUCCESS;
    }
}
