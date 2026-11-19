<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * 每個 API 請求的 log 都帶上 correlation_id（BFF 帶來的 X-Correlation-Id；沒有就產生），
 * 並把同一個 id 回在 response header → 前台、BFF、core、hub 的 log 可以用同一個 id 串起來。
 */
class AssignLogContext
{
    public function handle(Request $request, Closure $next): Response
    {
        $id = substr((string) $request->header('X-Correlation-Id'), 0, 64) ?: (string) Str::uuid();
        $request->headers->set('X-Correlation-Id', $id);
        Log::withContext(['correlation_id' => $id]);

        $started = microtime(true);
        $response = $next($request);
        Log::debug("{$request->method()} /{$request->path()} → {$response->getStatusCode()}", [
            'method' => $request->method(), 'path' => '/'.$request->path(), 'status' => $response->getStatusCode(),
            'ms' => (int) round((microtime(true) - $started) * 1000),
            // 只記「已經驗證過」的顧客；不要為了寫 log 去觸發驗證（會改變 guard 的狀態）
            'customer_id' => Auth::guard('customer')->hasUser() ? Auth::guard('customer')->id() : null,
        ]);
        $response->headers->set('X-Correlation-Id', $id);

        return $response;
    }
}
