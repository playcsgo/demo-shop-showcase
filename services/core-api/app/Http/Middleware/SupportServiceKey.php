<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

/**
 * /api/v1/internal/support/*：只有 AI 客服（support）的服務金鑰進得來（AIC-013）。
 * 金鑰和 BFF 的分開；core-api 沒設定金鑰時一律拒絕（空字串不能通過）。
 * X-Support-Actor 是 support 說「這次替誰查」（customer:<id>、staff:<id>、anonymous），只用來記 log，不用來授權。
 */
class SupportServiceKey
{
    public function handle(Request $request, Closure $next): Response
    {
        $key = (string) config('services.support.key');
        if ($key === '' || ! hash_equals($key, (string) $request->header('X-Service-Key'))) {
            return response()->json(['error' => 'invalid_service_key'], 401);
        }

        $actor = (string) $request->header('X-Support-Actor', '');
        Log::withContext(['support_actor' => preg_match('/^(customer|staff):\d+$|^anonymous$/', $actor) ? $actor : 'invalid']);

        return $next($request);
    }
}
