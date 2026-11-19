<?php

namespace App\Http\Middleware;

use App\Domain\DomainException;
use App\Enums\DistributorUserRole;
use App\Models\DistributorUser;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** 設定 shop 顯示只有 manager 可以；buyer 只下單 */
class RequireDistributorManager
{
    public function handle(Request $request, Closure $next): Response
    {
        /** @var DistributorUser $user */
        $user = $request->user();
        if ($user->role !== DistributorUserRole::Manager) {
            throw new DomainException('forbidden', '這個帳號不能變更設定', 403);
        }

        return $next($request);
    }
}
