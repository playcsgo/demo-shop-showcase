<?php

namespace App\Console\Commands;

use App\Domain\Ops\DemoReset;
use App\Models\Customer;
use App\Models\MerchantAccount;
use App\Models\Order;
use App\Models\ProductVariant;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * AI 客服 demo 用的訂單（AIC-014，spec §9）：DEMO-A～E。scripts/support.sh 在商店 demo:reset 之後呼叫。
 * 送達時間直接寫進出貨事件：超過退款期限的案例不能真的等 7 天。
 * 可以重跑：已經有的單號不動。不放進 DatabaseSeeder：測試和壓測的資料庫不該多出這些訂單
 */
class SupportDemoOrders extends Command
{
    protected $signature = 'support:demo-orders';

    protected $description = '建立 AI 客服 demo 用的訂單 DEMO-A～E（可重跑）';

    private const DAY = 86400;

    /** [單號, 客戶, [[SKU, 數量]], 幾秒前送達（null＝運送中）] */
    public static function orders(): array
    {
        return [
            ['DEMO-A', 'alice@example.test', [['DCS-PRO-30', 1], ['DCS-CAN-DUCK-80', 6]], 3 * self::DAY],   // 可退；益生菌有不適用提醒
            ['DEMO-B', 'alice@example.test', [['DCS-KIB-1500', 1]], 30 * self::DAY],                        // 超過期限
            ['DEMO-C', 'alice@example.test', [['DCS-LIT-1', 1]], null],                                      // 貓砂運送中
            ['DEMO-D', 'bob@example.test', [['DCS-DH-M', 1]], null],                                         // bob 的，alice 查不到
            ['DEMO-E', 'alice@example.test', [['DCS-JNT-60', 1]], 7 * self::DAY + 3 * 3600],                 // 剛過期限：AI 可能判斷可退，核准時被擋
        ];
    }

    public function handle(): int
    {
        if (! DemoReset::allowed()) {
            $this->error('正式環境不能建 demo 訂單');

            return self::FAILURE;
        }
        foreach (self::orders() as [$no, $email, $lines, $deliveredAgo]) {
            if (! Order::where('order_no', $no)->exists()) {
                $this->create($no, Customer::where('email', $email)->firstOrFail(), $lines, $deliveredAgo);
                $this->line("建立 {$no}");
            }
            $this->registerCharge(Order::with('payment')->where('order_no', $no)->first());
        }

        return self::SUCCESS;
    }

    /**
     * 這些訂單沒有真的經過金流：要在假金流登記這筆扣款，退款時金流才找得到（AIC-016）。
     * 每次都登記：partners 重啟後記憶體裡的扣款就不見了
     */
    private function registerCharge(Order $order): void
    {
        try {
            Http::timeout(5)->post(rtrim(config('services.partners.url'), '/').'/admin/charges', [
                'charge_id' => $order->payment->provider_txn_id, 'order_no' => $order->order_no, 'amount' => $order->payment->amount,
            ])->throw();
        } catch (\Throwable $e) {
            $this->warn("{$order->order_no}：假金流登記失敗，這張單的退款會失敗（{$e->getMessage()}）");
        }
    }

    private function create(string $no, Customer $customer, array $lines, ?int $deliveredAgo): void
    {
        $delivered = $deliveredAgo === null ? null : now()->subSeconds($deliveredAgo);
        $created = ($delivered ?? now()->subMinutes(15))->copy()->subDay();

        DB::transaction(function () use ($no, $customer, $lines, $delivered, $created) {
            $order = Order::create([
                'order_no' => $no, 'customer_id' => $customer->id, 'status' => $delivered ? 'COMPLETED' : 'FULFILLING',
                'subtotal' => 0, 'shipping_fee' => 0, 'total' => 0, 'correlation_id' => (string) Str::uuid(),
                'paid_at' => $created, 'created_at' => $created, 'updated_at' => $created,
            ]);
            $subtotal = 0;
            $byClass = [];
            foreach ($lines as [$sku, $qty]) {
                $v = ProductVariant::with('product.brand.legalEntity')->where('sku', $sku)->firstOrFail();
                $entity = $v->product->brand->legalEntity;
                $item = $order->items()->create([
                    'variant_id' => $v->id, 'sku' => $v->sku, 'product_name' => $v->name,
                    'unit_price' => $v->price, 'qty' => $qty, 'line_total' => $v->price * $qty,
                    'brand_id' => $v->product->brand_id, 'legal_entity_id' => $entity->id,
                    'commission_bps' => $entity->commissionBpsAt($created),
                    'shipping_class' => $v->shipping_class, 'fulfillment_type' => 'direct',
                    'fulfillment_status' => $delivered ? 'DONE' : 'PROCESSING',
                ]);
                $subtotal += $item->line_total;
                $byClass[$v->shipping_class->value][] = $item;
            }
            $order->update(['subtotal' => $subtotal, 'total' => $subtotal]);
            $order->payment()->create([
                'merchant_account_id' => MerchantAccount::value('id'), 'amount' => $subtotal,
                'status' => 'SUCCEEDED', 'provider_txn_id' => "txn_demo_{$no}",
                'idempotency_key' => "pay:{$no}", 'succeeded_at' => $created,
            ]);

            $seq = 1;
            foreach ($byClass as $class => $items) {
                $this->shipment($order, $seq++, $class, $items, $created, $delivered);
            }
        });
    }

    /** 已送達：取件、運送中、送達三筆事件；運送中：只有取件、運送中 */
    private function shipment(Order $order, int $seq, string $class, array $items, Carbon $created, ?Carbon $delivered): void
    {
        $carrier = $class === 'bulky' ? 'bulky_freight' : 'home_delivery';
        $tracking = ($class === 'bulky' ? 'BF' : 'HD')."DEMO{$order->order_no}{$seq}";
        $events = $delivered
            ? ['PICKED_UP' => $delivered->copy()->subHours(20), 'IN_TRANSIT' => $delivered->copy()->subHours(10), 'DELIVERED' => $delivered]
            : ['PICKED_UP' => now()->subMinutes(10), 'IN_TRANSIT' => now()->subMinutes(5)];
        $s = $order->shipments()->create([
            'seq' => $seq, 'shipping_class' => $class, 'carrier' => $carrier, 'tracking_no' => str_replace('-', '', $tracking),
            'status' => array_key_last($events), 'last_event_at' => end($events),
        ]);
        foreach ($items as $item) {
            $s->items()->create(['order_item_id' => $item->id, 'variant_id' => $item->variant_id, 'qty' => $item->qty]);
        }
        foreach ($events as $status => $at) {
            $s->events()->create(['status' => $status, 'occurred_at' => $at, 'provider_event_id' => "demo-{$order->order_no}-{$seq}-{$status}"]);
        }
    }
}
