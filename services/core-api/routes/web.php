<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\MediaController;
use Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\Support\Facades\Route;
use Illuminate\View\Middleware\ShareErrorsFromSession;

// 公鑰（JWKS）：BFF 或其他服務用來驗證 core 簽發的 JWT
Route::get('/.well-known/jwks.json', [AuthController::class, 'jwks']);

// 商品圖片（從 S3 串流）：瀏覽器看圖的網址，見 MediaController
// 不要 session／cookie：每張圖都開 session 很浪費，回應帶 Set-Cookie 也沒辦法給瀏覽器／CDN 快取
Route::get('/media/{path}', [MediaController::class, 'show'])->where('path', '.*')
    ->withoutMiddleware([EncryptCookies::class, AddQueuedCookiesToResponse::class, StartSession::class, ShareErrorsFromSession::class, ValidateCsrfToken::class]);
