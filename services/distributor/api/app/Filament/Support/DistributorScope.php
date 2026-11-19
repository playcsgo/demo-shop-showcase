<?php

namespace App\Filament\Support;

use App\Models\User;
use Illuminate\Database\Eloquent\Builder;

/** 業務只看得到自己負責的經銷商；super_admin 全部 */
class DistributorScope
{
    public static function user(): User
    {
        /** @var User */
        return auth()->user();
    }

    public static function distributors(Builder $query): Builder
    {
        $user = self::user();

        return $user->hasRole('super_admin') ? $query : $query->where('sales_user_id', $user->id);
    }
}
