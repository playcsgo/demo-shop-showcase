<?php

use App\Domain\Messaging\EventRouter;
use App\Domain\Messaging\InMemoryQueueClient;
use App\Domain\Messaging\OutboxRelay;
use App\Domain\Messaging\QueueClient;
use App\Domain\Payments\PaymentResultHandler;
use App\Domain\Reconciliation\InvariantChecker;
use App\Domain\Reconciliation\PaymentReconciler;
use App\Domain\Refunds\RefundService;
use App\Models\Order;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    $this->queue = new InMemoryQueueClient;
    app()->instance(QueueClient::class, $this->queue);
});

it('relay：送出 PENDING 的事件並標成 SENT；再跑一次不會重送', function () {
    checkoutOrder([['DCS-DCAN-BEEF-165', 'direct', 1, null]]);

    expect(app(OutboxRelay::class)->relayOnce())->toBe(1)
        ->and(app(OutboxRelay::class)->relayOnce())->toBe(0)
        ->and($this->queue->queues['payment-commands'])->toHaveCount(1)   // 付款請求送到金流的佇列（M17：指令依廠商分佇列）
        ->and(DB::table('outbox_messages')->where('status', 'SENT')->count())->toBe(1);
});

it('付款成功事件送 3 次：訂單只處理一次（inbox＋條件式轉移）', function () {
    $order = checkoutOrder([['DCS-DCAN-BEEF-165', 'direct', 1, null]]);
    $event = envelope('payment.succeeded', ['order_no' => $order->order_no, 'provider_txn_id' => 'txn_1', 'amount' => $order->total]);

    $results = array_map(fn () => app(EventRouter::class)->route($event), range(1, 3));

    expect($results)->toBe([true, false, false])
        ->and($order->fresh()->status->value)->toBe('FULFILLING')
        ->and(DB::table('shipments')->count())->toBe(1);
});

it('物流 callback 亂序：晚到的「配送中」不會蓋掉「已送達」', function () {
    $order = checkoutOrder([['DCS-DCAN-BEEF-165', 'direct', 1, null]]);
    app(PaymentResultHandler::class)->succeeded($order->order_no, 'txn', $order->total);
    $shipmentId = DB::table('shipments')->value('id');
    $router = app(EventRouter::class);

    $router->route(envelope('shipment.status_changed', ['shipment_id' => $shipmentId, 'status' => 'DELIVERED', 'occurred_at' => '2026-10-13T12:00:00Z', 'provider_event_id' => 'e3']));
    $router->route(envelope('shipment.status_changed', ['shipment_id' => $shipmentId, 'status' => 'IN_TRANSIT', 'occurred_at' => '2026-10-13T10:00:00Z', 'provider_event_id' => 'e2']));

    expect(DB::table('shipments')->value('status'))->toBe('DELIVERED')
        ->and(DB::table('shipment_events')->count())->toBe(2)               // 兩個事件都留下紀錄（軌跡）
        ->and($order->fresh()->status->value)->toBe('COMPLETED');
});

/** 預約訂單（TCC）：加入購物車時醫院已保留 → 結帳 → 回傳訂單 */
function bookingOrder(): Order
{
    return checkoutOrder([['DCS-SVC-HEALTH', 'booking', 1, now()->addDays(3)->setTime(6, 0)]]);
}

function commandsOf(string $type): Collection
{
    return DB::table('outbox_messages')->where('type', $type)->get()->map(fn ($m) => json_decode($m->payload, true)['payload']);
}

it('預約 TCC：保留 → 授權 → 醫院確認 → 請款 → 訂單完成（沒有退款）', function () {
    $order = bookingOrder();
    $router = app(EventRouter::class);

    expect(DB::table('bookings')->value('status'))->toBe('HELD')
        ->and(DB::table('payments')->value('capture_mode'))->toBe('manual')
        ->and(commandsOf('payment.requested')->first()['capture_mode'])->toBe('manual');

    $router->route(envelope('payment.authorized', ['order_no' => $order->order_no, 'provider_txn_id' => 'ch_1', 'amount' => $order->total]));
    expect(DB::table('bookings')->value('status'))->toBe('AUTHORIZED')
        ->and(DB::table('payments')->value('status'))->toBe('AUTHORIZED')
        ->and(commandsOf('booking.confirm.requested')->first()['hold_id'])->toBe('hold_0')
        ->and($order->fresh()->status->value)->toBe('PENDING_PAYMENT');   // 還沒請款 → 還不算付款

    $router->route(envelope('booking.confirmed', ['booking_id' => DB::table('bookings')->value('id'), 'provider_booking_id' => 'vet_1']));
    expect(commandsOf('payment.capture.requested'))->toHaveCount(1);

    $router->route(envelope('payment.succeeded', ['order_no' => $order->order_no, 'provider_txn_id' => 'ch_1', 'amount' => $order->total]));
    expect($order->fresh()->status->value)->toBe('COMPLETED')
        ->and(DB::table('payments')->value('status'))->toBe('SUCCEEDED')
        ->and(DB::table('refunds')->count())->toBe(0);
});

it('預約 TCC：醫院確認失敗（保留過期）→ 取消授權＋釋放時段，訂單取消，客人沒有被扣款', function () {
    $order = bookingOrder();
    $router = app(EventRouter::class);
    $router->route(envelope('payment.authorized', ['order_no' => $order->order_no, 'provider_txn_id' => 'ch_1', 'amount' => $order->total]));

    $router->route(envelope('booking.failed', ['booking_id' => DB::table('bookings')->value('id'), 'reason' => 'hold_expired']));
    expect($order->fresh()->status->value)->toBe('CANCELLED')
        ->and(DB::table('bookings')->value('status'))->toBe('CANCELLED')
        ->and(commandsOf('payment.void.requested'))->toHaveCount(1)
        ->and(commandsOf('booking.release.requested')->first()['hold_id'])->toBe('hold_0')
        ->and(commandsOf('payment.capture.requested'))->toHaveCount(0);

    $router->route(envelope('payment.voided', ['order_no' => $order->order_no]));
    expect(DB::table('payments')->value('status'))->toBe('VOIDED')
        ->and(DB::table('refunds')->count())->toBe(0)
        ->and(collect(app(InvariantChecker::class)->check())->every(fn ($r) => $r['ok']))->toBeTrue();
});

it('預約 TCC：確認和失敗同時到（醫院回應遺失後重試）→ 只有先到的生效', function () {
    $order = bookingOrder();
    $router = app(EventRouter::class);
    $router->route(envelope('payment.authorized', ['order_no' => $order->order_no, 'provider_txn_id' => 'ch_1', 'amount' => $order->total]));
    $bookingId = DB::table('bookings')->value('id');

    $router->route(envelope('booking.confirmed', ['booking_id' => $bookingId, 'provider_booking_id' => 'vet_1']));
    $router->route(envelope('booking.failed', ['booking_id' => $bookingId, 'reason' => 'clinic_unavailable']));

    expect(DB::table('bookings')->value('status'))->toBe('CONFIRMED')
        ->and(commandsOf('payment.void.requested'))->toHaveCount(0)
        ->and($order->fresh()->status->value)->toBe('PENDING_PAYMENT');
});

it('預約 TCC：付款失敗 → 釋放醫院的時段', function () {
    $order = bookingOrder();
    app(EventRouter::class)->route(envelope('payment.failed', ['order_no' => $order->order_no, 'reason' => 'declined']));

    expect(DB::table('bookings')->value('status'))->toBe('CANCELLED')
        ->and(commandsOf('booking.release.requested'))->toHaveCount(1);
});

it('預約 TCC：訂單已失敗才收到授權（晚到）→ 自動取消授權', function () {
    $order = bookingOrder();
    $router = app(EventRouter::class);
    $router->route(envelope('payment.failed', ['order_no' => $order->order_no, 'reason' => 'charge_not_found_after_expiry']));
    $router->route(envelope('payment.authorized', ['order_no' => $order->order_no, 'provider_txn_id' => 'ch_late', 'amount' => $order->total]));

    expect(commandsOf('payment.void.requested')->first()['provider_txn_id'])->toBe('ch_late')
        ->and(DB::table('payments')->value('status'))->toBe('AUTHORIZED');   // 等 payment.voided 回來才變 VOIDED
});

it('預約 TCC：授權後卡住 → 對帳重送下一步', function () {
    $order = bookingOrder();
    app(EventRouter::class)->route(envelope('payment.authorized', ['order_no' => $order->order_no, 'provider_txn_id' => 'ch_1', 'amount' => $order->total]));
    $this->travel(2)->minutes();

    expect(app(PaymentReconciler::class)->redriveAuthorizations())->toBe(1)
        ->and(commandsOf('booking.confirm.requested'))->toHaveCount(2)
        ->and(app(PaymentReconciler::class)->redriveAuthorizations())->toBe(0); // 剛重送過，不會馬上再送
});

it('喵的商品退款成功：結算分錄回沖', function () {
    $order = checkoutOrder([['DCS-WAND-1', 'direct', 2, null]]);
    app(PaymentResultHandler::class)->succeeded($order->order_no, 'txn', $order->total);
    $item = $order->items->first();

    $refund = app(RefundService::class)->request($order->fresh(), [$item->id => 1], 'cs', 'r1');
    app(EventRouter::class)->route(envelope('refund.succeeded', ['refund_id' => $refund->id, 'provider_refund_id' => 'rf']));

    $sum = DB::table('settlement_entries')->sum('amount');
    // 銷售 360 − 抽成 54 − 手續費 7 − 退款 180 ＋ 抽成回沖 27
    expect((int) $sum)->toBe(360 - 54 - 7 - 180 + 27)
        ->and($order->fresh()->status->value)->toBe('PARTIALLY_REFUNDED');
});
