<?php

namespace App\Domain\Cart;

use App\Domain\Booking\ClinicGateway;
use App\Domain\DomainException;
use App\Domain\Messaging\Outbox;
use App\Enums\FulfillmentType;
use App\Models\Cart;
use App\Models\CartItem;
use App\Models\Customer;
use App\Models\ProductVariant;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * 伺服器端購物車（§6.2，與電商登入後的做法一致）
 * 預約商品（§6.4.1）：加入購物車時就向醫院「保留」時段（TCC 的 Try），付錢前就知道有沒有位子。
 */
class CartService
{
    public function __construct(private CartRules $rules, private ClinicGateway $clinic, private Outbox $outbox) {}

    public function cartOf(Customer $customer): Cart
    {
        return Cart::firstOrCreate(['customer_id' => $customer->id])->load('items.variant.product.brand');
    }

    public function putItem(Customer $customer, int $variantId, FulfillmentType $type, int $qty, ?Carbon $appointmentAt): Cart
    {
        $variant = ProductVariant::with('product')->findOrFail($variantId);

        if ($variant->product->status !== 'active') {
            throw new DomainException('product_inactive', '商品已下架');
        }
        if (! $variant->product->allows($type->value)) {
            throw new DomainException('fulfillment_not_allowed', "{$variant->name} 不支援 {$type->value}");
        }

        $cart = $this->cartOf($customer);
        $hold = null;
        if ($type === FulfillmentType::Booking) {
            if (! $appointmentAt || $appointmentAt->isPast()) {
                throw new DomainException('appointment_required', '預約商品需選擇未來的日期時段');
            }
            $qty = 1;
            // 先檢查組合規則，避免保留了時段才發現不能加入
            $this->rules->assertCombinable($cart->items->reject(fn ($i) => $i->variant_id === $variantId && $i->fulfillment_type === $type)
                ->push(new CartItem(['variant_id' => $variantId, 'fulfillment_type' => $type])));
            $hold = $this->holdSlot($cart, $variant, $appointmentAt);
        }

        $cart->items()->updateOrCreate(
            ['variant_id' => $variantId, 'fulfillment_type' => $type],
            ['qty' => $qty, 'appointment_at' => $appointmentAt, 'hold_id' => $hold['hold_id'] ?? null, 'hold_expires_at' => $hold['expires_at'] ?? null],
        );

        $cart->load('items.variant.product.brand');
        try {
            $this->rules->assertCombinable($cart->items);
        } catch (DomainException $e) {
            $cart->items()->where(['variant_id' => $variantId, 'fulfillment_type' => $type])->delete();
            throw $e;
        }

        return $cart;
    }

    public function removeItem(Customer $customer, int $cartItemId): Cart
    {
        $cart = $this->cartOf($customer);
        $item = $cart->items->firstWhere('id', $cartItemId);
        DB::transaction(function () use ($cart, $item, $cartItemId) {
            $cart->items()->whereKey($cartItemId)->delete();
            if ($item?->hold_id) {
                $this->releaseHold($item->hold_id, 'cart_removed');
            }
        });

        return $cart->load('items.variant.product.brand');
    }

    /** 向醫院保留時段；同一個時段重複加入沿用原本的保留，換時段會先釋放舊的 */
    private function holdSlot(Cart $cart, ProductVariant $variant, Carbon $appointmentAt): array
    {
        $existing = $cart->items->first(fn ($i) => $i->variant_id === $variant->id && $i->fulfillment_type === FulfillmentType::Booking);
        if ($existing?->hold_id && $existing->appointment_at?->equalTo($appointmentAt) && $existing->hold_expires_at?->isFuture()) {
            return ['hold_id' => $existing->hold_id, 'expires_at' => $existing->hold_expires_at];
        }

        // 每次新的保留用新的 hold_key：購物車結帳後會沿用同一個 ID，用「購物車＋時段」當 key，
        // 再訂同一個時段會拿回上一筆已確認的保留 → bookings.hold_id 重複（sandbox 連續跑同一套抓到的）。
        // 冪等只需要涵蓋這一次請求的重送（hub 呼叫醫院失敗時重試，帶的是同一個 key）
        $startAt = $appointmentAt->copy()->timezone('Asia/Taipei')->toIso8601String();
        $hold = $this->clinic->hold('hold:'.Str::uuid(), $startAt, $variant->service_type);

        Log::info('clinic slot held', ['hold_id' => $hold['hold_id'], 'start_at' => $startAt, 'expires_at' => $hold['expires_at']]);
        if ($existing?->hold_id && $existing->hold_id !== $hold['hold_id']) {
            DB::transaction(fn () => $this->releaseHold($existing->hold_id, 'slot_changed'));
        }

        return ['hold_id' => $hold['hold_id'], 'expires_at' => Carbon::parse($hold['expires_at'])->utc()];
    }

    private function releaseHold(string $holdId, string $reason): void
    {
        $this->outbox->record('booking.release.requested', 'core-commands', ['hold_id' => $holdId, 'reason' => $reason], (string) Str::uuid());
    }
}
