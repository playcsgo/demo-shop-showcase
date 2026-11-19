<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * sandbox 報告用：一筆訂單「最後變成什麼樣子」（log 說發生了什麼，這裡說結果是什麼，兩邊對照找問題）
 *   php artisan sandbox:snapshot A261013XYZ A261013ABC
 * 輸出 JSON：每筆訂單的 orders、明細、付款、退款、預約、出貨、庫存預留，以及同一個 correlation_id 的 outbox 訊息
 */
class SandboxSnapshot extends Command
{
    protected $signature = 'sandbox:snapshot {order_no* : 一到多個訂單編號}';

    protected $description = '匯出訂單相關資料表的最後狀態（JSON）';

    public function handle(): int
    {
        $out = [];
        foreach ($this->argument('order_no') as $orderNo) {
            $order = DB::table('orders')->where('order_no', $orderNo)->first();
            if (! $order) {
                $out[$orderNo] = null;

                continue;
            }
            $shipmentIds = DB::table('shipments')->where('order_id', $order->id)->pluck('id');
            $out[$orderNo] = [
                'order' => $order,
                'items' => DB::table('order_items')->where('order_id', $order->id)->get(),
                'payments' => DB::table('payments')->where('order_id', $order->id)->get(),
                'refunds' => DB::table('refunds')->where('order_id', $order->id)->get(),
                'bookings' => DB::table('bookings')->where('order_no', $orderNo)->get(),
                'shipments' => DB::table('shipments')->where('order_id', $order->id)->get(),
                'shipment_events' => DB::table('shipment_events')->whereIn('shipment_id', $shipmentIds)->orderBy('id')->get(),
                'reservations' => DB::table('inventory_reservations')->where('order_id', $order->id)->get(),
                // 同時間（前後 10 秒）還有哪些訂單買了同樣的商品：競態問題常常來自這裡
                'concurrent_orders' => DB::table('orders as o')->join('order_items as oi', 'oi.order_id', '=', 'o.id')
                    ->whereIn('oi.variant_id', DB::table('order_items')->where('order_id', $order->id)->pluck('variant_id'))
                    ->where('o.id', '<>', $order->id)
                    ->whereBetween('o.created_at', [Carbon::parse($order->created_at)->subSeconds(10), Carbon::parse($order->created_at)->addSeconds(10)])
                    ->distinct()->pluck('o.order_no'),
                'outbox' => DB::table('outbox_messages')->where('correlation_id', $order->correlation_id)->orderBy('id')
                    ->get(['id', 'event_id', 'type', 'status', 'attempts', 'created_at', 'sent_at']),
            ];
        }
        $this->line(json_encode($out, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));

        return self::SUCCESS;
    }
}
