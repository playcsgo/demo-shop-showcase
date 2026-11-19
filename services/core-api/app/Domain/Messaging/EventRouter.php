<?php

namespace App\Domain\Messaging;

use App\Domain\Booking\BookingResultHandler;
use App\Domain\Payments\PaymentResultHandler;
use App\Domain\Refunds\RefundCompletion;
use App\Domain\Shipping\ShipmentStatusHandler;

/**
 * 把 integration-events 佇列的事件交給對應的處理程式；外層用 inbox 保證同一個 event_id 只處理一次。
 */
class EventRouter
{
    public function __construct(private Inbox $inbox) {}

    /** @return bool false＝重複事件（已處理過） */
    public function route(array $envelope): bool
    {
        $p = $envelope['payload'];

        return $this->inbox->handleOnce($envelope['event_id'], $envelope['type'], fn () => match ($envelope['type']) {
            'payment.submitted' => app(PaymentResultHandler::class)->submitted($p['order_no'], $p['provider_txn_id']),
            'payment.succeeded' => app(PaymentResultHandler::class)->succeeded($p['order_no'], $p['provider_txn_id'], $p['amount']),
            'payment.authorized' => app(PaymentResultHandler::class)->authorized($p['order_no'], $p['provider_txn_id'], $p['amount']),
            'payment.voided' => app(PaymentResultHandler::class)->voided($p['order_no']),
            'payment.failed' => app(PaymentResultHandler::class)->failed($p['order_no'], $p['reason'] ?? 'unknown'),
            'refund.succeeded' => app(RefundCompletion::class)->succeeded($p),
            'refund.failed' => app(RefundCompletion::class)->failed($p),
            'shipment.status_changed' => app(ShipmentStatusHandler::class)->handle($p),
            'booking.confirmed' => app(BookingResultHandler::class)->confirmed($p),
            'booking.failed' => app(BookingResultHandler::class)->failed($p),
            default => throw new \UnexpectedValueException("不認識的事件類型 {$envelope['type']}"),
        });
    }
}
