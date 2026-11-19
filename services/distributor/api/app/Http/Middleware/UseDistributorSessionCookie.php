<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** 經銷商和員工的 session 分開：同一台瀏覽器兩邊都登入時，員工在後台登出不會把經銷商也登出 */
class UseDistributorSessionCookie
{
    public const COOKIE = 'distributor_web_session';

    public function handle(Request $request, Closure $next): Response
    {
        config(['session.cookie' => self::COOKIE]);

        return $next($request);
    }
}
