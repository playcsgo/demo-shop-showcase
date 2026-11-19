<?php

namespace App\Policies;

use App\Models\User;
use App\Models\Ingredient;

/** 全公司共用，沒有負責人範圍 */
class IngredientPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('country_rules.manage');
    }

    public function view(User $user, Ingredient $record): bool
    {
        return $user->can('country_rules.manage');
    }

    public function create(User $user): bool
    {
        return $user->can('country_rules.manage');
    }

    public function update(User $user, Ingredient $record): bool
    {
        return $user->can('country_rules.manage');
    }

    public function delete(User $user, Ingredient $record): bool
    {
        return $user->can('country_rules.manage') && ! $record->isInUse();
    }
}
