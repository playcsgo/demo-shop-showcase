<?php

namespace App\Domain\Checkout;

use App\Domain\Cart\CartRules;
use App\Domain\Catalog\InventoryService;
use App\Domain\DomainException;
use App\Domain\Messaging\Outbox;
use App\Domain\Observability\PipelineMetrics;
use App\Domain\Ordering\ShipmentPlanner;
use App\Enums\FulfillmentType;
use App\Models\Cart;
use App\Models\Customer;
use App\Models\MerchantAccount;
use App\Models\Order;
use App\Models\ProductVariant;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * 結帳＝Saga 第 1、2 步（§6.3）：
 *  1. 建立訂單（PENDING_PAYMENT）＋明細快照＋預留庫存
 *  2. 同一個交易寫 outbox：payment.requested
 * 之後由 hub 呼叫金流，結果經 inbox 回來（PaymentResultHandler）。
 * 預約訂單（§6.4.1）：付款只「授權」，醫院確認後才請款；失敗就取消授權（BookingResultHandler）。
 */
class CheckoutService
{
    public function __construct(
        private CartRules $rules,
        private InventoryService $inventory,
        private ShipmentPlanner $planner,
        private Outbox $outbox,
    ) {}

    public function checkout(Customer $customer, array $utm, string $correlationId): Order
    {
        return DB::transaction(function () use ($customer, $utm, $correlationId) {
            $cart = Cart::where('customer_id', $customer->id)->lockForUpdate()->first();
            $items = $cart?->items()->with('variant.product.brand.legalEntity')->get() ?? collect();

            if ($items->isEmpty()) {
                throw new DomainException('cart_empty', '購物車是空的');
            }
            $this->rules->assertCombinable($items);
            $this->assertHoldsValid($items);

            $order = $this->placeOrder($customer, $items->map(fn ($ci) => [
                'variant' => $ci->variant, 'qty' => $ci->qty,
                'fulfillment_type' => $ci->fulfillment_type, 'appointment_at' => $ci->appointment_at,
                'hold_id' => $ci->hold_id, 'hold_expires_at' => $ci->hold_expires_at,
            ])->all(), $utm, $correlationId);

            $cart->items()->delete();

            return $order;
        });
    }

    /**
     * 預約的保留必須還夠久：至少撐過付款期限，否則可能「付完款，時段已經過期」（§6.4.1 時間順序）
     */
    private function assertHoldsValid($items): void
    {
        $minUntil = now()->addSeconds(config('shop.booking.hold_min_remaining_seconds'));
        foreach ($items->where('fulfillment_type', FulfillmentType::Booking) as $item) {
            if (! $item->hold_id || $item->hold_expires_at->lt($minUntil)) {
                throw new DomainException('hold_expired', '預約時段的保留快到期了，請回商品頁重新選擇時段', 409);
            }
        }
    }

    /**
     * 建立訂單（結帳與訂閱續期共用）：訂單＋明細快照＋運費＋付款＋outbox＋預留庫存，同一個交易。
     *
     * 預留庫存放在交易的「最後」：預留是條件式 UPDATE，會鎖住那個商品的庫存列，一直到 commit 才放開。
     * 熱門商品大家搶同一列，持有鎖的時間越長，排隊越久（壓測實測：每秒 120 筆下單時，
     * 60 條連線卡在同一句 UPDATE inventory、平均等 401 ms）。所以其他寫入都先做完，最後才鎖、馬上 commit。
     * 而且依商品 id 排序再鎖：兩筆訂單買到相同的兩件商品時，鎖的順序一致，不會互相等對方（死鎖）。
     * 庫存不足一樣會丟例外、整個交易回滾（只是前面的寫入白做了，換來的是平常每一筆都少等很多）。
     * 分桶的商品快賣完時，一張訂單可能要從好幾桶湊（InventoryService::reserve），極少數情況兩筆訂單互等對方的桶 →
     * MySQL 判定死鎖、回滾其中一筆 → 整個交易重做（最多 3 次）。
     *
     * @param  list<array{variant: ProductVariant, qty: int, fulfillment_type: FulfillmentType, appointment_at: ?\DateTimeInterface}>  $lines
     */
    public function placeOrder(Customer $customer, array $lines, array $utm, string $correlationId, ?int $subscriptionId = null): Order
    {
        return DB::transaction(function () use ($customer, $lines, $utm, $correlationId, $subscriptionId) {
            $order = Order::create([
                'order_no' => self::newOrderNo(),
                'customer_id' => $customer->id,
                'subtotal' => 0, 'shipping_fee' => 0, 'total' => 0,
                'subscription_id' => $subscriptionId,
                'utm_source' => $utm['utm_source'] ?? null,
                'utm_medium' => $utm['utm_medium'] ?? null,
                'utm_campaign' => $utm['utm_campaign'] ?? null,
                'correlation_id' => $correlationId,
            ]);

            $subtotal = 0;
            $shippable = [];
            $bookings = [];
            $reservations = [];
            foreach ($lines as $line) {
                $v = $line['variant']->loadMissing('product.brand.legalEntity');
                $entity = $v->product->brand->legalEntity;
                $item = $order->items()->create([
                    'variant_id' => $v->id, 'sku' => $v->sku, 'product_name' => $v->name,
                    'unit_price' => $v->price, 'qty' => $line['qty'], 'line_total' => $v->price * $line['qty'],
                    'brand_id' => $v->product->brand_id, 'legal_entity_id' => $entity->id,
                    'commission_bps' => $entity->commissionBpsAt(now()),
                    'shipping_class' => $v->shipping_class, 'fulfillment_type' => $line['fulfillment_type'],
                    'appointment_at' => $line['appointment_at'] ?? null,
                ]);
                $subtotal += $item->line_total;

                if (! $v->isService()) {
                    $reservations[] = [$v->id, $line['qty']];   // 先記下來，交易最後才鎖庫存
                }
                if ($line['fulfillment_type'] === FulfillmentType::Booking) {
                    $bookings[] = [$item, $line, $v];
                }
                if (in_array($line['fulfillment_type'], [FulfillmentType::Direct, FulfillmentType::Subscription], true)) {
                    $shippable[] = ['key' => $item->id, 'variant_id' => $v->id, 'qty' => $line['qty'], 'shipping_class' => $v->shipping_class];
                }
            }

            $shippingFee = $this->planner->totalFee($this->planner->plan($shippable));
            $order->update(['subtotal' => $subtotal, 'shipping_fee' => $shippingFee, 'total' => $subtotal + $shippingFee]);

            // 預約：醫院已經保留時段（HELD）；付款只授權，醫院確認後才請款（TCC，§6.4.1）
            foreach ($bookings as [$item, $line, $v]) {
                DB::table('bookings')->insert([
                    'order_item_id' => $item->id, 'order_no' => $order->order_no, 'service_type' => $v->service_type,
                    'appointment_at' => $line['appointment_at'], 'hold_id' => $line['hold_id'], 'hold_expires_at' => $line['hold_expires_at'],
                    'status' => 'HELD', 'created_at' => now(), 'updated_at' => now(),
                ]);
                $item->update(['fulfillment_status' => 'PROCESSING']);
            }

            $merchant = MerchantAccount::firstOrFail();
            $payment = $order->payment()->create([
                'merchant_account_id' => $merchant->id, 'amount' => $order->total,
                'status' => 'PENDING', 'capture_mode' => $bookings ? 'manual' : 'auto',
                'idempotency_key' => "pay:{$order->order_no}",
            ]);

            $requestedAt = PipelineMetrics::requestStart();
            $this->outbox->record('payment.requested', 'core-commands', array_filter([
                'order_no' => $order->order_no,
                'payment_id' => $payment->id,
                'amount' => $order->total,
                'currency' => 'TWD',
                'merchant_id' => $merchant->merchant_id,
                'idempotency_key' => $payment->idempotency_key,
                'capture_mode' => $payment->capture_mode,             // manual：只授權
                'payment_token_ref' => $customer->payment_token_ref, // mock：綁卡 token，訂閱續扣也用它
                // 客人按下結帳的時間（nginx 收到）：hub 交給物流時算整筆花多久；排程續訂沒有 → 不放
                'requested_at_ms' => $requestedAt ? (int) round($requestedAt * 1000) : null,
            ], fn ($v) => $v !== null), $correlationId);

            // 最後才預留庫存（鎖庫存列），依商品 id 排序；預留完就 commit，鎖持有的時間最短
            usort($reservations, fn ($a, $b) => $a[0] <=> $b[0]);
            $expiresAt = now()->addSeconds(config('shop.reservation_ttl_seconds'));
            foreach ($reservations as [$variantId, $qty]) {
                $this->inventory->reserve($order->id, $variantId, $qty, $expiresAt);
            }

            Log::info('order placed', ['order_no' => $order->order_no, 'total' => $order->total, 'items' => count($lines), 'capture_mode' => $payment->capture_mode]);

            return $order->load('items');
        }, attempts: 3);
    }

    public static function newOrderNo(): string
    {
        return 'A'.now()->format('ymd').strtoupper(Str::random(7));
    }
}
