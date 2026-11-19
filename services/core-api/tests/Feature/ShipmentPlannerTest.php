<?php

use App\Domain\Ordering\ShipmentPlanner;
use App\Enums\ShippingClass;

function line(string $key, int $qty, ShippingClass $class): array
{
    return ['key' => $key, 'variant_id' => crc32($key), 'qty' => $qty, 'shipping_class' => $class];
}

it('狗屋＋貓砂＋項圈＋布偶 → 3 個包裹（狗屋｜貓砂｜項圈＋布偶）', function () {
    $packages = app(ShipmentPlanner::class)->plan([
        line('doghouse', 1, ShippingClass::Bulky),
        line('litter', 2, ShippingClass::Litter),
        line('collar', 1, ShippingClass::Standard),
        line('plush', 1, ShippingClass::Standard),
    ]);

    expect($packages)->toHaveCount(3)
        ->and(array_column($packages[0]['lines'], 'key'))->toBe(['collar', 'plush'])
        ->and($packages[0]['carrier'])->toBe('home_delivery')
        ->and($packages[1]['shipping_class'])->toBe(ShippingClass::Litter)
        ->and($packages[2]['shipping_class'])->toBe(ShippingClass::Bulky)
        ->and($packages[2]['carrier'])->toBe('bulky_freight');
});

it('大型商品每件一個包裹；服務不產生包裹；運費依包裹加總', function () {
    $planner = app(ShipmentPlanner::class);
    $packages = $planner->plan([
        line('doghouse', 2, ShippingClass::Bulky),
        line('health-check', 1, ShippingClass::Service),
    ]);

    expect($packages)->toHaveCount(2)
        ->and($packages[0]['lines'][0]['qty'])->toBe(1)
        ->and($planner->totalFee($packages))->toBe(3000);
});
