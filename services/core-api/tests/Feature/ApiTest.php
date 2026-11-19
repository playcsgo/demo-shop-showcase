<?php

use App\Models\Order;
use Illuminate\Support\Facades\DB;

it('沒有 JWT 或 JWT 是偽造的：401', function () {
    $this->getJson('/api/v1/cart')->assertStatus(401);
    $this->withHeaders(['Authorization' => 'Bearer forged.token.here'])->getJson('/api/v1/cart')->assertStatus(401);
});

it('JWKS 只公開公鑰', function () {
    $key = $this->getJson('/.well-known/jwks.json')->assertOk()->json('keys.0');
    expect($key)->toHaveKeys(['kty', 'kid', 'n', 'e'])->not->toHaveKey('d');
});

it('同一個 Idempotency-Key 結帳兩次：只有一張訂單，第二次回同一個結果', function () {
    $h = loginAs('alice@example.test');
    putCart($h, 'DCS-DCAN-BEEF-165', 'direct', 2);

    $first = $this->withHeaders($h + ['Idempotency-Key' => 'k1'])->postJson('/api/v1/checkout')->assertCreated();
    $second = $this->withHeaders($h + ['Idempotency-Key' => 'k1'])->postJson('/api/v1/checkout')->assertCreated();

    expect($second->json('order_no'))->toBe($first->json('order_no'))
        ->and($second->headers->get('Idempotent-Replayed'))->toBe('true')
        ->and(Order::count())->toBe(1);
});

it('結帳必須帶 Idempotency-Key', function () {
    $h = loginAs('alice@example.test');
    putCart($h, 'DCS-DCAN-BEEF-165', 'direct');

    $this->withHeaders($h)->postJson('/api/v1/checkout')->assertStatus(400)->assertJson(['error' => 'idempotency_key_required']);
});

it('訂閱商品不能和其他商品同車', function () {
    $h = loginAs('alice@example.test');
    putCart($h, 'DCS-DCAN-BEEF-165', 'direct');

    putCart($h, 'DCS-PRO-30', 'subscription')->assertStatus(422)->assertJson(['error' => 'subscription_must_checkout_alone']);
});

it('商品不支援的交付方式會被拒絕；預約一定要帶時段', function () {
    $h = loginAs('alice@example.test');

    putCart($h, 'DCS-DH-M', 'warehouse')->assertStatus(422)->assertJson(['error' => 'fulfillment_not_allowed']);
    putCart($h, 'DCS-SVC-HEALTH', 'booking')->assertStatus(422)->assertJson(['error' => 'appointment_required']);
});

it('預約：加入購物車就向醫院保留時段；額滿當場告知；不能和商品同車', function () {
    $h = loginAs('alice@example.test');
    $at = now()->addDays(3)->setTime(6, 0)->toIso8601String();

    putCart($h, 'DCS-SVC-HEALTH', 'booking', 1, $at)->assertSuccessful()->assertJsonPath('items.0.hold_expires_at', fn ($v) => $v !== null);
    expect($this->clinic->holds)->toHaveCount(1);

    putCart($h, 'DCS-DCAN-BEEF-165', 'direct')->assertStatus(422)->assertJson(['error' => 'booking_must_checkout_alone']);

    $this->clinic->full = true;
    app('auth')->forgetGuards();
    $bob = loginAs('bob@example.test');
    putCart($bob, 'DCS-SVC-HEALTH', 'booking', 1, $at)->assertStatus(409)->assertJson(['error' => 'slot_full']);
    $this->getJson('/api/v1/cart', $bob)->assertJsonCount(0, 'items');   // 沒保留到 → 不會進購物車
});

it('預約：同一位客人結帳後再訂同一個時段，要拿到新的保留（購物車 ID 會沿用）', function () {
    // sandbox 抓到的 bug：hold_key 用「購物車＋時段」→ 第二次拿回上一筆已確認的保留 → bookings.hold_id 重複 → 500
    $h = loginAs('alice@example.test');
    $at = now()->addDays(3)->setTime(6, 0)->toIso8601String();

    putCart($h, 'DCS-SVC-HEALTH', 'booking', 1, $at)->assertSuccessful();
    $this->withHeaders($h + ['Idempotency-Key' => 'b1'])->postJson('/api/v1/checkout')->assertSuccessful();

    putCart($h, 'DCS-SVC-HEALTH', 'booking', 1, $at)->assertSuccessful();
    $this->withHeaders($h + ['Idempotency-Key' => 'b2'])->postJson('/api/v1/checkout')->assertSuccessful();

    expect(DB::table('bookings')->distinct()->count('hold_id'))->toBe(2);
});

it('預約：同一個時段在購物車裡重複加入，不會重複保留', function () {
    $h = loginAs('alice@example.test');
    $at = now()->addDays(3)->setTime(6, 0)->toIso8601String();

    putCart($h, 'DCS-SVC-HEALTH', 'booking', 1, $at)->assertSuccessful();
    putCart($h, 'DCS-SVC-HEALTH', 'booking', 1, $at)->assertSuccessful();

    expect($this->clinic->holds)->toHaveCount(1);
});

it('預約：保留快到期就不能結帳（避免付完款時段已過期）', function () {
    $h = loginAs('alice@example.test');
    putCart($h, 'DCS-SVC-HEALTH', 'booking', 1, now()->addDays(3)->setTime(6, 0)->toIso8601String())->assertSuccessful();
    DB::table('cart_items')->update(['hold_expires_at' => now()->addSeconds(30)]);

    $this->withHeaders($h + ['Idempotency-Key' => 'kb'])->postJson('/api/v1/checkout')->assertStatus(409)->assertJson(['error' => 'hold_expired']);
});

it('結帳時預留庫存；庫存不足整張訂單不成立', function () {
    $h = loginAs('alice@example.test');
    putCart($h, 'DCS-DH-M', 'direct', 7); // 庫存只有 6

    $this->withHeaders($h + ['Idempotency-Key' => 'k1'])->postJson('/api/v1/checkout')
        ->assertStatus(409)->assertJson(['error' => 'insufficient_stock']);
    expect(Order::count())->toBe(0)->and(DB::table('outbox_messages')->count())->toBe(0);
});

it('顧客看不到別人的訂單（擁有權在 core 判斷）', function () {
    $alice = loginAs('alice@example.test');
    putCart($alice, 'DCS-DCAN-BEEF-165', 'direct');
    $orderNo = $this->withHeaders($alice + ['Idempotency-Key' => 'k1'])->postJson('/api/v1/checkout')->json('order_no');

    $bob = loginAs('bob@example.test');
    // 測試裡多個請求共用同一個 app，guard 會快取上一個請求解析出的使用者（登入路由的 throttle 也會觸發解析）；
    // 正式環境每個請求都是新的生命週期，沒有這個問題
    app('auth')->forgetGuards();
    $this->withHeaders($bob)->getJson("/api/v1/orders/{$orderNo}")->assertNotFound();
});
