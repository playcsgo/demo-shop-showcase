<?php

namespace App\Domain\Fulfillment;

use App\Domain\Messaging\Outbox;
use App\Domain\Ordering\ShipmentPlanner;
use App\Domain\Warehouse\WarehouseService;
use App\Enums\FulfillmentType;
use App\Models\Order;
use App\Models\Subscription;
use Illuminate\Support\Facades\DB;

/**
 * 付款成功後，依「每個明細的交付方式」分組處理（§6.4）：
 *  - 直送（含訂閱的這一期）：依 shipping_class 拆包裹，每包一則 shipment.requested
 *  - 寄倉：帳本入帳，明細立即完成
 *  - 預約：付款前醫院已確認（TCC）→ 明細直接完成
 *  - 訂閱：第一期就是這張訂單；建立訂閱，之後由排程每期產生新訂單
 * 必須在 PaymentResultHandler 的交易內呼叫。
 */
class FulfillmentDispatcher
{
    public function __construct(
        private ShipmentPlanner $planner,
        private WarehouseService $warehouse,
        private Outbox $outbox,
        private OrderProgress $progress,
    ) {}

    public function dispatch(Order $order): void
    {
        $order->loadMissing('items.variant.product.brand', 'customer');
        $shippable = [];

        foreach ($order->items as $item) {
            match ($item->fulfillment_type) {
                FulfillmentType::Direct, FulfillmentType::Subscription => $shippable[] = [
                    'key' => $item->id, 'variant_id' => $item->variant_id, 'qty' => $item->qty, 'shipping_class' => $item->shipping_class,
                ],
                FulfillmentType::Warehouse => $this->deposit($order, $item),
                FulfillmentType::Booking => $this->book($order, $item),
            };

            if ($item->fulfillment_type === FulfillmentType::Subscription && $order->subscription_id === null) {
                $this->startSubscription($order, $item);
            }
        }

        foreach ($this->planner->plan($shippable) as $seq => $package) {
            $this->ship($order, $seq + 1, $package);
        }

        $this->progress->refresh($order->id);
    }

    private function ship(Order $order, int $seq, array $package): void
    {
        $shipmentId = DB::table('shipments')->insertGetId([
            'order_id' => $order->id, 'seq' => $seq,
            'shipping_class' => $package['shipping_class']->value, 'carrier' => $package['carrier'],
            'status' => 'REQUESTED', 'shipping_fee' => $package['fee'],
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $items = [];
        foreach ($package['lines'] as $line) {
            DB::table('shipment_items')->insert([
                'shipment_id' => $shipmentId, 'order_item_id' => $line['key'], 'variant_id' => $line['variant_id'], 'qty' => $line['qty'],
            ]);
            $orderItem = $order->items->firstWhere('id', $line['key']);
            DB::table('order_items')->where('id', $line['key'])->where('fulfillment_status', 'PENDING')->update(['fulfillment_status' => 'PROCESSING']);
            $items[] = ['sku' => $orderItem->sku, 'name' => $orderItem->product_name, 'qty' => $line['qty']];
        }

        $this->outbox->record('shipment.requested', 'core-commands', [
            'shipment_id' => $shipmentId,
            'source' => 'order',
            'order_no' => $order->order_no,
            'package_seq' => $seq,
            'carrier' => $package['carrier'],
            'shipping_class' => $package['shipping_class']->value,   // 物流商分得出貓砂和一般商品（AIC-017）
            'items' => $items,
        ], $order->correlation_id);
    }

    private function deposit(Order $order, $item): void
    {
        $this->warehouse->deposit($order->customer_id, $item->variant_id, $item->qty, 'order_item', $item->id, "deposit:{$item->id}");
        DB::table('order_items')->where('id', $item->id)->update(['fulfillment_status' => 'DONE', 'updated_at' => now()]);
    }

    /** 預約在付款前就由醫院確認了（TCC，§6.4.1）；請款成功＝服務已預約好 → 明細完成 */
    private function book(Order $order, $item): void
    {
        DB::table('order_items')->where('id', $item->id)
            ->whereExists(fn ($q) => $q->from('bookings')->whereColumn('bookings.order_item_id', 'order_items.id')->where('bookings.status', 'CONFIRMED'))
            ->update(['fulfillment_status' => 'DONE', 'updated_at' => now()]);
    }

    private function startSubscription(Order $order, $item): void
    {
        $sub = Subscription::create([
            'customer_id' => $order->customer_id, 'variant_id' => $item->variant_id, 'origin_order_id' => $order->id,
            'qty' => $item->qty,
            'interval_seconds' => config('shop.subscription.interval_seconds'),
            'total_cycles' => config('shop.subscription.total_cycles'),
            'next_cycle_no' => 2,
            'next_run_at' => now()->addSeconds(config('shop.subscription.interval_seconds')),
            'status' => 'ACTIVE',
            'payment_token_ref' => $order->customer->payment_token_ref ?? 'tok_missing',
        ]);
        $sub->cycles()->create(['cycle_no' => 1, 'order_id' => $order->id, 'status' => 'PAID', 'attempts' => 1]);
        DB::table('orders')->where('id', $order->id)->update(['subscription_id' => $sub->id]);
    }
}
