<?php

namespace App\Console\Commands;

use App\Domain\Refunds\RefundService;
use App\Models\Order;
use Illuminate\Console\Command;

/** 開發／混沌測試用：隨機對已付款的訂單做部分退款（模擬客服操作） */
class RefundRandom extends Command
{
    protected $signature = 'dev:refund-random {count=5}';

    protected $description = '隨機部分退款（開發用）';

    public function handle(RefundService $refunds): int
    {
        $orders = Order::with('items', 'payment')->whereIn('status', ['FULFILLING', 'COMPLETED', 'PAID'])
            ->inRandomOrder()->limit((int) $this->argument('count'))->get();

        foreach ($orders as $order) {
            $item = $order->items->first(fn ($i) => $i->refundableQty() > 0 && $i->fulfillment_type->value !== 'warehouse');
            if (! $item) {
                continue;
            }
            // 壓測用：不管送達多久都要能退，帶例外原因略過期限（AIC-016）
            $refund = $refunds->request($order, [$item->id => 1], 'cs_random', "dev-refund:{$order->order_no}:{$item->id}",
                requestedBy: 'load_test', overrideReason: 'load_test');
            $this->line("refund {$refund->id}: {$order->order_no} {$item->product_name} ×1 = {$refund->amount}");
        }

        return self::SUCCESS;
    }
}
