<?php

use App\Domain\Cart\CartService;
use App\Domain\Checkout\CheckoutService;
use App\Domain\DomainException;
use App\Enums\FulfillmentType;
use App\Models\Customer;
use App\Models\MerchantAccount;
use App\Models\Order;
use App\Models\ProductVariant;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function variant(string $sku): ProductVariant
{
    return ProductVariant::with('product.brand.legalEntity')->where('sku', $sku)->firstOrFail();
}

function alice(): Customer
{
    return Customer::where('email', 'alice@example.test')->firstOrFail();
}

/** 只建訂單本體（測試庫存預留時用；明細由測試自己決定） */
function pendingOrder(?Customer $customer = null): Order
{
    return Order::create([
        'order_no' => 'T'.strtoupper(Str::random(10)),
        'customer_id' => ($customer ?? alice())->id,
        'subtotal' => 0, 'shipping_fee' => 0, 'total' => 0,
        'correlation_id' => (string) Str::uuid(),
    ]);
}

/**
 * 直接建一張「已付款」訂單（跳過結帳流程，M3 測核心規則用）
 *
 * @param  list<array{0:string,1:int,2?:string}>  $lines  [sku, qty, fulfillment_type]
 */
function paidOrder(array $lines, ?Customer $customer = null): Order
{
    return DB::transaction(function () use ($lines, $customer) {
        $order = pendingOrder($customer);
        $subtotal = 0;

        foreach ($lines as $line) {
            [$sku, $qty] = $line;
            $type = $line[2] ?? FulfillmentType::Direct->value;
            $v = variant($sku);
            $entity = $v->product->brand->legalEntity;

            $order->items()->create([
                'variant_id' => $v->id, 'sku' => $v->sku, 'product_name' => $v->name,
                'unit_price' => $v->price, 'qty' => $qty, 'line_total' => $v->price * $qty,
                'brand_id' => $v->product->brand_id, 'legal_entity_id' => $entity->id,
                'commission_bps' => $entity->commissionBpsAt(now()),
                'shipping_class' => $v->shipping_class, 'fulfillment_type' => $type,
            ]);
            $subtotal += $v->price * $qty;
        }

        $order->update(['subtotal' => $subtotal, 'total' => $subtotal, 'status' => 'PAID', 'paid_at' => now()]);
        $order->payment()->create([
            'merchant_account_id' => MerchantAccount::value('id'), 'amount' => $subtotal,
            'status' => 'SUCCEEDED', 'provider_txn_id' => 'txn_'.Str::random(12),
            'idempotency_key' => "pay:{$order->order_no}", 'succeeded_at' => now(),
        ]);

        return $order->fresh(['items', 'payment']);
    });
}

/**
 * 真的併發：fork 出 $n 個程序，各自建立新的資料庫連線，在同一個時間點一起執行 $work($i)。
 *
 * @return list<array{ok:bool, error:?string, value:mixed}>
 */
function concurrently(int $n, callable $work): array
{
    $dir = sys_get_temp_dir().'/concurrency-'.Str::random(8);
    mkdir($dir);
    DB::disconnect(); // 子程序不能共用父程序的連線
    $startAt = microtime(true) + 0.5; // 簡易「起跑線」：全部等到同一時間才開始

    $pids = [];
    for ($i = 0; $i < $n; $i++) {
        $pid = pcntl_fork();
        if ($pid === 0) {
            DB::purge();
            DB::reconnect();
            usleep((int) max(0, ($startAt - microtime(true)) * 1_000_000));
            try {
                $result = ['ok' => true, 'error' => null, 'value' => $work($i)];
            } catch (Throwable $e) {
                $result = ['ok' => false, 'error' => $e instanceof DomainException ? $e->reason : $e->getMessage(), 'value' => null];
            }
            file_put_contents("{$dir}/{$i}.json", json_encode($result));
            DB::disconnect();
            posix_kill(posix_getpid(), SIGKILL); // 不跑 PHPUnit 的收尾程式
        }
        $pids[] = $pid;
    }

    foreach ($pids as $pid) {
        pcntl_waitpid($pid, $status);
    }
    DB::reconnect();

    $results = [];
    for ($i = 0; $i < $n; $i++) {
        $results[] = json_decode((string) @file_get_contents("{$dir}/{$i}.json"), true) ?? ['ok' => false, 'error' => 'child crashed', 'value' => null];
    }
    array_map('unlink', glob("{$dir}/*"));
    rmdir($dir);

    return $results;
}

/** 事件的標準格式（hub 送給 core 的 integration-events） */
function envelope(string $type, array $payload, ?string $eventId = null): array
{
    return ['event_id' => $eventId ?? (string) Str::uuid(), 'type' => $type, 'version' => 1,
        'occurred_at' => now()->toIso8601ZuluString(), 'correlation_id' => 'c', 'payload' => $payload];
}

/** 用 API 的同一條路徑建立 PENDING_PAYMENT 訂單（不經 HTTP） */
function checkoutOrder(array $lines): Order
{
    $customer = alice();
    foreach ($lines as [$sku, $type, $qty, $at]) {
        app(CartService::class)->putItem($customer, variant($sku)->id, FulfillmentType::from($type), $qty, $at);
    }

    return app(CheckoutService::class)->checkout($customer, [], (string) Str::uuid());
}

/** 前台客戶登入，回傳帶 JWT 的 header（ApiTest、SupportApiTest 共用） */
function loginAs(string $email): array
{
    $token = test()->postJson('/api/v1/auth/login', ['email' => $email, 'password' => '0204'])->json('access_token');

    return ['Authorization' => "Bearer {$token}"];
}

function putCart(array $headers, string $sku, string $type, int $qty = 1, ?string $at = null)
{
    return test()->withHeaders($headers)->putJson('/api/v1/cart/items', array_filter([
        'variant_id' => variant($sku)->id, 'fulfillment_type' => $type, 'qty' => $qty, 'appointment_at' => $at,
    ]));
}
