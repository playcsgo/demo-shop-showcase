<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CartController;
use App\Http\Controllers\Api\CatalogController;
use App\Http\Controllers\Api\CheckoutController;
use App\Http\Controllers\Api\OrderController;
use App\Http\Controllers\Api\ServiceTokenController;
use App\Http\Controllers\Api\SubscriptionController;
use App\Http\Controllers\Api\WarehouseController;
use App\Http\Controllers\Internal\SupportController;
use App\Http\Middleware\SupportServiceKey;
use Illuminate\Support\Facades\Route;

/*
 * core-api 的 REST API（前綴 /api/v1）。前台不直接呼叫，由 bff-gateway 帶 JWT 呼叫（§3.2）。
 */
Route::post('auth/login', [AuthController::class, 'login'])->middleware('throttle:login');
Route::get('catalog', [CatalogController::class, 'index']);
Route::post('auth/service-token', [ServiceTokenController::class, 'exchange'])->middleware('throttle:600,1'); // BFF 專用

Route::middleware('auth:customer')->group(function () {
    Route::get('me', [AuthController::class, 'me']);

    Route::get('cart', [CartController::class, 'show']);
    Route::put('cart/items', [CartController::class, 'putItem']);
    Route::delete('cart/items/{itemId}', [CartController::class, 'removeItem'])->whereNumber('itemId');

    Route::post('checkout', [CheckoutController::class, 'store']);

    Route::get('orders', [OrderController::class, 'index']);
    Route::get('orders/{orderNo}', [OrderController::class, 'show']);

    Route::get('subscriptions', [SubscriptionController::class, 'index']);

    Route::get('warehouse', [WarehouseController::class, 'index']);
    Route::post('warehouse/withdrawals', [WarehouseController::class, 'withdraw']);
});

// AI 客服（support）用的 API：服務金鑰，不經過客戶的 JWT（AIC-013）
Route::prefix('internal/support')->middleware(SupportServiceKey::class)->controller(SupportController::class)->group(function () {
    Route::get('products', 'products');
    Route::get('products/{slug}', 'product');
    Route::get('products/{slug}/variants', 'variants');
    Route::get('variants/{sku}', 'variant');
    Route::get('variants/{sku}/delivery-estimate', 'deliveryEstimate');   // AIC-017
    Route::get('customers', 'customers');
    Route::get('customers/{customer}/orders', 'orders')->whereNumber('customer');
    Route::get('customers/{customer}/orders/{orderNo}', 'order')->whereNumber('customer');
    Route::get('customers/{customer}/orders/{orderNo}/shipments', 'shipments')->whereNumber('customer');
    Route::get('customers/{customer}/orders/{orderNo}/refunds', 'refunds')->whereNumber('customer');
    // 退款（AIC-016）：預覽只算不寫；申請要客服核准過的提案
    Route::post('customers/{customer}/orders/{orderNo}/refund-preview', 'refundPreview')->whereNumber('customer');
    Route::post('customers/{customer}/orders/{orderNo}/refunds', 'refund')->whereNumber('customer');
    Route::get('refunds/{refund}', 'refundStatus')->whereNumber('refund');
});
