<?php

use App\Domain\Refunds\RefundCompletion;
use App\Models\Customer;
use App\Models\Order;
use App\Models\Shipment;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

// AI 客服核准退款（AIC-016）：預覽只算不寫；申請先過 RefundPolicy，再走原本的 RefundService（非同步）

beforeEach(fn () => config(['services.support.key' => 'k']));

function supportPost(string $path, array $body): TestResponse
{
    return test()->withHeaders(['X-Service-Key' => 'k', 'X-Support-Actor' => 'staff:3'])->postJson("/api/v1/internal/support/{$path}", $body);
}

function deliveredDaysAgo(Order $order, float $days): void
{
    $s = Shipment::create(['order_id' => $order->id, 'seq' => 1, 'shipping_class' => 'standard', 'carrier' => 'home_delivery', 'tracking_no' => "R{$order->id}", 'status' => 'DELIVERED']);
    foreach ($order->items as $i) {
        $s->items()->create(['order_item_id' => $i->id, 'variant_id' => $i->variant_id, 'qty' => $i->qty]);
    }
    $s->events()->create(['status' => 'DELIVERED', 'occurred_at' => now()->subMinutes((int) ($days * 1440)), 'provider_event_id' => "rd{$order->id}"]);
}

it('預覽：可退時回金額，什麼都不寫', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 3]]);
    deliveredDaysAgo($order, 2);
    $item = $order->items->first();

    supportPost('customers/'.alice()->id."/orders/{$order->order_no}/refund-preview", ['lines' => [$item->id => 2]])
        ->assertOk()->assertExactJson(['data' => ['eligible' => true, 'code' => null, 'amount' => 96]]);
    expect(DB::table('refunds')->count())->toBe(0)->and($item->fresh()->refunded_qty)->toBe(0);
});

it('預覽和申請：別人的訂單 404', function () {
    $bobs = paidOrder([['DCS-WAND-1', 1]], Customer::where('email', 'bob@example.test')->first());
    $line = [$bobs->items[0]->id => 1];
    supportPost('customers/'.alice()->id."/orders/{$bobs->order_no}/refund-preview", ['lines' => $line])->assertNotFound();
    supportPost('customers/'.alice()->id."/orders/{$bobs->order_no}/refunds", ['lines' => $line, 'idempotency_key' => 'support-proposal:a', 'staff_id' => 3, 'proposal_id' => 'a'])->assertNotFound();
});

it('AC-47：申請成功 202 PENDING；reason 和 requested_by 記下提案和客服', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 3]]);
    deliveredDaysAgo($order, 2);
    $item = $order->items->first();

    $proposal = (string) Str::uuid();   // 真的提案 id 是 UUID：欄位長度要放得下
    $r = supportPost('customers/'.alice()->id."/orders/{$order->order_no}/refunds", [
        'lines' => [$item->id => 2], 'idempotency_key' => "support-proposal:{$proposal}", 'staff_id' => 3, 'proposal_id' => $proposal,
    ])->assertStatus(202)->json('data');

    expect($r)->toMatchArray(['status' => 'PENDING', 'amount' => 96])
        ->and(DB::table('refunds')->first())
        ->reason->toBe('support_proposal')
        ->idempotency_key->toBe("support-proposal:{$proposal}")
        ->requested_by->toBe('support_staff:3');
});

it('AC-47：超過期限 409 refund_window_expired，錢和數量沒動', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 1]]);
    deliveredDaysAgo($order, 7.2);

    supportPost('customers/'.alice()->id."/orders/{$order->order_no}/refunds", [
        'lines' => [$order->items[0]->id => 1], 'idempotency_key' => 'support-proposal:p2', 'staff_id' => 3, 'proposal_id' => 'p2',
    ])->assertStatus(409)->assertJson(['error' => 'refund_window_expired']);
    expect(DB::table('refunds')->count())->toBe(0)->and($order->payment->fresh()->refunded_amount)->toBe(0);
});

it('冪等：同一個鍵送兩次，回同一筆退款', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 3]]);
    $body = ['lines' => [$order->items[0]->id => 1], 'idempotency_key' => 'support-proposal:p3', 'staff_id' => 3, 'proposal_id' => 'p3'];
    $a = supportPost('customers/'.alice()->id."/orders/{$order->order_no}/refunds", $body)->json('data.refund_id');
    $b = supportPost('customers/'.alice()->id."/orders/{$order->order_no}/refunds", $body)->json('data.refund_id');

    expect($a)->toBe($b)->and(DB::table('refunds')->count())->toBe(1);
});

it('格式不對：422', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 3]]);
    supportPost('customers/'.alice()->id."/orders/{$order->order_no}/refunds", ['lines' => 'x'])->assertStatus(422);
    supportPost('customers/'.alice()->id."/orders/{$order->order_no}/refund-preview", ['lines' => [$order->items[0]->id => -1]])->assertStatus(422);
});

it('查退款狀態：金流成功後是 SUCCEEDED，訂單 PARTIALLY_REFUNDED', function () {
    $order = paidOrder([['DCS-CAN-DUCK-80', 3]]);
    $id = supportPost('customers/'.alice()->id."/orders/{$order->order_no}/refunds", [
        'lines' => [$order->items[0]->id => 1], 'idempotency_key' => 'support-proposal:p4', 'staff_id' => 3, 'proposal_id' => 'p4',
    ])->json('data.refund_id');
    $status = fn () => test()->withHeaders(['X-Service-Key' => 'k'])->getJson("/api/v1/internal/support/refunds/{$id}")->assertOk()->json('data');

    expect($status())->toMatchArray(['status' => 'PENDING', 'amount' => 48, 'order_status' => 'PAID']);
    app(RefundCompletion::class)->succeeded(['refund_id' => $id, 'provider_refund_id' => 'p']);
    expect($status())->toMatchArray(['status' => 'SUCCEEDED', 'order_status' => 'PARTIALLY_REFUNDED']);
    test()->withHeaders(['X-Service-Key' => 'k'])->getJson('/api/v1/internal/support/refunds/999999')->assertNotFound();
});
