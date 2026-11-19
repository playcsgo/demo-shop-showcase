<?php

use App\Domain\Ordering\OrderTransitions;
use App\Enums\OrderStatus;

it('付款成功的通知重複送達：只有第一次會轉移', function () {
    $order = pendingOrder();
    $t = app(OrderTransitions::class);

    expect($t->transition($order->id, OrderStatus::Paid, ['paid_at' => now()]))->toBeTrue()
        ->and($t->transition($order->id, OrderStatus::Paid, ['paid_at' => now()]))->toBeFalse();
});

it('狀態不能倒退：已付款的訂單不能變成付款失敗', function () {
    $order = pendingOrder();
    $t = app(OrderTransitions::class);
    $t->transition($order->id, OrderStatus::Paid);

    expect($t->transition($order->id, OrderStatus::PaymentFailed))->toBeFalse()
        ->and($order->fresh()->status)->toBe(OrderStatus::Paid);
});
