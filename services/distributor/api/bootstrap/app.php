<?php

use App\Domain\DomainException;
use App\Http\Middleware\UseDistributorSessionCookie;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/*
 * 經銷商服務的組裝圖。獨立於商店：只有自己的 MySQL，不呼叫其他服務
 *  - /admin 是員工的 Filament 後台
 *  - /api/v1/b2b 是經銷商前台的 API
 */
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/b2b.php',
        apiPrefix: 'api/v1/b2b',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // 經銷商前台用 session cookie 登入（HttpOnly、SameSite=Lax），API 這組也要有 session
        $middleware->api(prepend: [UseDistributorSessionCookie::class, EncryptCookies::class, AddQueuedCookiesToResponse::class, StartSession::class]);
        // 框架預設導到名叫 login 的路由，這裡沒有 → API 沒帶 Accept: application/json 會變 500。
        // 後台不受影響：Filament 的 Authenticate 有自己的 redirectTo
        $middleware->redirectGuestsTo(fn () => null);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // 業務規則被違反是正常的回應，不是系統錯誤 → 不寫 ERROR log
        $exceptions->dontReport(DomainException::class);

        // API 的錯誤一律長這樣：{"error": 給程式看的代碼, "message": 給人看的說明}
        $exceptions->render(fn (DomainException $e) => response()->json(['error' => $e->reason, 'message' => $e->getMessage()] + $e->details, $e->status));
        // 只管 API；後台交回框架，才會導到登入頁
        $exceptions->render(function (AuthenticationException $e, Request $r) {
            if ($r->is('api/*')) {
                return response()->json(['error' => 'unauthenticated', 'message' => '請先登入'], 401);
            }
        });
        $exceptions->render(function (ValidationException $e, Request $r) {
            if ($r->is('api/*')) {
                return response()->json(['error' => 'validation_failed', 'message' => $e->getMessage(), 'errors' => $e->errors()], 422);
            }
        });
        $exceptions->render(function (NotFoundHttpException $e, Request $r) {
            if ($r->is('api/*')) {
                return response()->json(['error' => 'not_found', 'message' => '找不到'], 404);
            }
        });
    })->create();
