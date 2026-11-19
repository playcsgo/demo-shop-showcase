<?php

namespace App\Http\Middleware;

use App\Domain\Observability\PipelineMetrics;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * 每個 API 請求從 nginx 收到到回應送出花了多久 → demo.pipeline.handle_ms{step:core-api.post.checkout}
 * 在 terminate 才送：回應已經送出去了（客人不用等這個 UDP），量到的也包含送回應的時間
 */
class RecordHandleTime
{
    public function __construct(private PipelineMetrics $metrics) {}

    public function handle(Request $request, Closure $next): Response
    {
        return $next($request);
    }

    public function terminate(Request $request, Response $response): void
    {
        $route = $request->route()?->uri();
        $started = PipelineMetrics::requestStart();
        if ($route && $started) {   // 沒有對到路由的（404）不記：路徑每個都不一樣
            // api/v1/cart/items/{itemId} → core-api.delete.cart.items.itemid（tag 只用小寫、點分隔，Datadog 查詢不用跳脫）
            $path = str_replace(['/', '{', '}'], ['.', '', ''], preg_replace('#^api/v\d+/#', '', $route));
            $this->metrics->handled('core-api.'.strtolower($request->method().'.'.$path), $started);
        }
    }
}
