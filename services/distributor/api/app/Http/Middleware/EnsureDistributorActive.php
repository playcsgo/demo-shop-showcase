<?php

namespace App\Http\Middleware;

use App\Enums\DistributorStatus;
use App\Models\DistributorUser;
use Closure;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/** 公司被停權，已登入的 session 立刻失效，不用等過期 */
class EnsureDistributorActive
{
    public function handle(Request $request, Closure $next): Response
    {
        /** @var DistributorUser $user */
        $user = $request->user();
        if ($user->distributor()->value('status') !== DistributorStatus::Active) {
            Auth::guard('distributor')->logout();
            throw new AuthenticationException;
        }

        return $next($request);
    }
}
