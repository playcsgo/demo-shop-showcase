<?php

use App\Http\Controllers\Api\B2b\AuthController;
use App\Http\Controllers\Api\B2b\BatchController;
use App\Http\Controllers\Api\B2b\OrderController;
use App\Http\Controllers\Api\B2b\ShopController;
use App\Http\Controllers\Api\B2b\ShopItemController;
use App\Http\Middleware\EnsureDistributorActive;
use App\Http\Middleware\RequireDistributorManager;
use Illuminate\Support\Facades\Route;

/*
 * 經銷商的 REST API（網址前綴 /api/v1/b2b，見 bootstrap/app.php）
 * 經銷商前台同網域呼叫，用 session cookie 登入。別家的資料一律回 404，不透露這筆資料存在
 */
Route::post('auth/login', [AuthController::class, 'login'])->middleware('throttle:login');

Route::middleware(['auth:distributor', EnsureDistributorActive::class])->group(function () {
    Route::post('auth/logout', [AuthController::class, 'logout']);
    Route::get('me', [AuthController::class, 'me']);

    Route::get('shops', [ShopController::class, 'index']);   // 沒有 POST：shop 由業務在後台建立
    Route::get('shops/{id}', [ShopController::class, 'show'])->whereNumber('id');
    Route::get('shops/{id}/catalog', [ShopItemController::class, 'catalog'])->whereNumber('id');

    Route::post('batches/preview', [BatchController::class, 'preview']);
    Route::post('batches', [BatchController::class, 'store']);
    Route::get('batches', [BatchController::class, 'index']);
    Route::get('batches/{batchNo}', [BatchController::class, 'show']);
    Route::put('batches/{batchNo}', [BatchController::class, 'resubmit']);
    Route::get('batches/{batchNo}/revisions', [BatchController::class, 'revisions']);

    Route::get('orders', [OrderController::class, 'index']);
    Route::get('orders/{orderNo}', [OrderController::class, 'show']);

    // 順序：先驗證登入才查角色；查角色在查 shop 之前，buyer 不會因為 id 存不存在得到不同回應
    Route::middleware(RequireDistributorManager::class)->group(function () {
        Route::get('shops/{id}/item-settings', [ShopItemController::class, 'settings'])->whereNumber('id');
        Route::put('shops/{id}/items', [ShopItemController::class, 'update'])->whereNumber('id');
    });
});
