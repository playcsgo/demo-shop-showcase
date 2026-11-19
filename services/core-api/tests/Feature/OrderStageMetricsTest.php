<?php

use App\Domain\Messaging\EventRouter;
use App\Domain\Observability\OrderStageMetrics;
use App\Domain\Observability\StatsD;
use App\Domain\Payments\PaymentResultHandler;
use Illuminate\Support\Facades\DB;

/** 記下送出的指標，不真的送 UDP */
class FakeStatsD extends StatsD
{
    /** @var list<array{string, float|int, array<string, string>}> */
    public array $sent = [];

    public function __construct()
    {
        parent::__construct('fake');
    }

    public function distribution(string $metric, float|int $value, array $tags = []): void
    {
        $this->sent[] = [$metric, $value, $tags];
    }

    /** @return list<string> */
    public function stages(): array
    {
        return array_map(fn ($s) => $s[2]['stage'], array_filter($this->sent, fn ($s) => $s[0] === OrderStageMetrics::METRIC));
    }
}

beforeEach(function () {
    $this->statsd = new FakeStatsD;
    app()->instance(StatsD::class, $this->statsd);
});

it('訂單走到每個階段都記「從下單到這裡幾秒」：付款送出、付款確認、出貨中、送達、完成', function () {
    $order = checkoutOrder([['DCS-DCAN-BEEF-165', 'direct', 1, null]]);
    $handler = app(PaymentResultHandler::class);

    $handler->submitted($order->order_no, 'txn');
    $handler->succeeded($order->order_no, 'txn', $order->total);
    $shipmentId = DB::table('shipments')->value('id');
    app(EventRouter::class)->route(envelope('shipment.status_changed', ['shipment_id' => $shipmentId, 'status' => 'DELIVERED', 'occurred_at' => now()->toIso8601String(), 'provider_event_id' => 'd1']));

    expect($this->statsd->stages())->toBe(['payment_submitted', 'paid', 'fulfilling', 'shipment_delivered', 'completed'])
        ->and(collect($this->statsd->sent)->every(fn ($s) => $s[1] >= 0))->toBeTrue();
});

it('重複的付款成功通知不會重複記（狀態沒有轉移就不記）', function () {
    $order = checkoutOrder([['DCS-DCAN-BEEF-165', 'direct', 1, null]]);
    $handler = app(PaymentResultHandler::class);

    $handler->succeeded($order->order_no, 'txn', $order->total);
    $handler->succeeded($order->order_no, 'txn', $order->total);

    expect(array_count_values($this->statsd->stages())['paid'])->toBe(1);
});

it('沒開 Datadog 時什麼都不送', function () {
    app()->instance(StatsD::class, new StatsD(null));
    $order = checkoutOrder([['DCS-DCAN-BEEF-165', 'direct', 1, null]]);

    app(PaymentResultHandler::class)->succeeded($order->order_no, 'txn', $order->total);

    expect($this->statsd->sent)->toBe([]);
});
