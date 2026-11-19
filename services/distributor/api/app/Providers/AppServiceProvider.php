<?php

namespace App\Providers;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // 大量指派不擋欄位：資料一律先經過驗證、由程式組好才寫入
        Model::unguard();

        // 開發和測試時，迴圈裡偷偷多查資料庫（N+1）直接丟例外，逼自己寫 with(...)
        Model::preventLazyLoading(! $this->app->isProduction());

        JsonResource::withoutWrapping();

        // 登入限流：同一個「帳號＋IP」每分鐘 10 次
        RateLimiter::for('login', fn (Request $r) => Limit::perMinute(10)->by(strtolower((string) $r->input('email')).'|'.$r->ip()));
    }
}
