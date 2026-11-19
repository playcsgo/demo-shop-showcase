<?php

namespace App\Domain\Ordering;

use App\Enums\ShippingClass;

/**
 * 拆包裹（§5.4）：依 shipping_class，不依品牌。
 *  - standard：同單合併成一個包裹
 *  - litter（貓砂）：獨立一個包裹
 *  - bulky（狗屋、紙城堡）：每「件」一個包裹，走大型物流
 *  - service（健康檢查）：不出貨
 * 純函式：只看輸入、不碰資料庫，最好測。
 */
class ShipmentPlanner
{
    /**
     * @param  iterable<array{key:mixed, variant_id:int, qty:int, shipping_class:ShippingClass}>  $lines
     * @return list<array{shipping_class:ShippingClass, carrier:string, fee:int, lines:list<array{key:mixed, variant_id:int, qty:int}>}>
     */
    public function plan(iterable $lines): array
    {
        $standard = [];
        $litter = [];
        $packages = [];

        foreach ($lines as $line) {
            $line = (array) $line;
            $item = ['key' => $line['key'], 'variant_id' => $line['variant_id'], 'qty' => $line['qty']];

            match ($line['shipping_class']) {
                ShippingClass::Standard => $standard[] = $item,
                ShippingClass::Litter => $litter[] = $item,
                ShippingClass::Bulky => array_push($packages, ...array_map(
                    fn () => $this->package(ShippingClass::Bulky, [[...$item, 'qty' => 1]]),
                    range(1, $line['qty']),
                )),
                ShippingClass::Service => null,
            };
        }

        if ($litter) {
            array_unshift($packages, $this->package(ShippingClass::Litter, $litter));
        }
        if ($standard) {
            array_unshift($packages, $this->package(ShippingClass::Standard, $standard));
        }

        return $packages;
    }

    public function totalFee(array $packages): int
    {
        return array_sum(array_column($packages, 'fee'));
    }

    private function package(ShippingClass $class, array $lines): array
    {
        return [
            'shipping_class' => $class,
            'carrier' => $class->carrier(),
            'fee' => (int) config("shop.shipping_fees.{$class->value}"),
            'lines' => $lines,
        ];
    }
}
