<?php

use App\Domain\DomainException;
use App\Http\Middleware\AssignLogContext;
use App\Http\Middleware\RecordHandleTime;
use App\Http\Middleware\SimulateDbLatency;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        apiPrefix: 'api/v1',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->api(prepend: [RecordHandleTime::class, AssignLogContext::class]); // 每個請求的處理時間（Datadog）；log 帶 correlation_id（M14）
        $middleware->api(append: [SimulateDbLatency::class]); // 只在連線數實驗時開啟
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // 業務規則被違反是正常回應，不是系統錯誤 → 不寫 ERROR log（避免告警噪音）
        $exceptions->dontReport(DomainException::class);

        // 統一錯誤格式：{ "error": 機器可讀代碼, "message": 給人看的說明 }
        $exceptions->render(fn (DomainException $e) => response()->json(['error' => $e->reason, 'message' => $e->getMessage()], $e->status));
        $exceptions->render(fn (AuthenticationException $e, Request $r) => response()->json(['error' => 'unauthenticated'], 401));
        $exceptions->render(function (NotFoundHttpException $e, Request $r) {
            if ($r->is('api/*')) {
                return response()->json(['error' => 'not_found'], 404);
            }
        });
        $exceptions->shouldRenderJsonWhen(fn (Request $r) => $r->is('api/*') || $r->expectsJson());
    })->create();
