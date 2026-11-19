<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * 只給連線數實驗用（§12.2）：每個 API 請求先在資料庫等 N 毫秒，模擬大促時查詢變慢、連線被佔更久。
 * 預設關閉（DEMO_DB_LATENCY_MS=0）；正式環境不會設定。
 */
class SimulateDbLatency
{
    public function handle(Request $request, Closure $next)
    {
        $ms = (int) config('shop.demo_db_latency_ms');
        if ($ms > 0) {
            DB::select('SELECT SLEEP(?)', [$ms / 1000]);
        }

        return $next($request);
    }
}
