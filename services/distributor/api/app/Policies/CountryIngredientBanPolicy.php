<?php

namespace App\Policies;

use App\Models\User;
use App\Models\CountryIngredientBan;

/** 全公司共用，沒有負責人範圍 */
class CountryIngredientBanPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('country_rules.manage');
    }

    public function view(User $user, CountryIngredientBan $record): bool
    {
        return $user->can('country_rules.manage');
    }

    public function create(User $user): bool
    {
        return $user->can('country_rules.manage');
    }

    public function update(User $user, CountryIngredientBan $record): bool
    {
        return $user->can('country_rules.manage');
    }

    public function delete(User $user, CountryIngredientBan $record): bool
    {
        return $user->can('country_rules.manage');
    }
}
