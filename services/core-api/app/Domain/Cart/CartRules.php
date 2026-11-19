<?php

namespace App\Domain\Cart;

use App\Domain\DomainException;
use App\Enums\FulfillmentType;
use App\Models\CartItem;
use Illuminate\Support\Collection;

/**
 * 購物車組合規則（§5.4、§6.2）。加入購物車和結帳時都會檢查。
 *  - 可以混合品牌、可以混合直送／寄倉
 *  - 訂閱商品單獨結帳（只能有一項，且不能和其他商品同車）
 *  - 預約單獨結帳（B14）：付款是「先授權、醫院確認後才請款」，失敗時取消授權；和商品混在一起就做不到
 *  - 寄倉的貓砂不能和其他商品同一張訂單
 */
class CartRules
{
    /** @param  Collection<int, CartItem>  $items （需載入 variant） */
    public function assertCombinable(Collection $items): void
    {
        $subscriptions = $items->filter(fn ($i) => $i->fulfillment_type === FulfillmentType::Subscription);
        if ($subscriptions->isNotEmpty() && $items->count() > 1) {
            throw new DomainException('subscription_must_checkout_alone', '訂閱商品需單獨結帳');
        }

        $bookings = $items->filter(fn ($i) => $i->fulfillment_type === FulfillmentType::Booking);
        if ($bookings->isNotEmpty() && $items->count() > 1) {
            throw new DomainException('booking_must_checkout_alone', '預約服務需單獨結帳（先保留時段，醫院確認後才請款）');
        }

        $litterWarehouse = $items->filter(fn ($i) => $i->fulfillment_type === FulfillmentType::Warehouse && $i->variant->is_litter);
        if ($litterWarehouse->isNotEmpty() && $litterWarehouse->count() !== $items->count()) {
            throw new DomainException('litter_warehouse_must_checkout_alone', '寄倉貓砂不能和其他商品同一張訂單');
        }
    }
}
