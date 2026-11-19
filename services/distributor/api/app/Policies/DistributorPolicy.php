<?php

namespace App\Policies;

use App\Models\Distributor;
use App\Models\User;

/** RBAC（有 distributors.manage）＋ 負責的業務，兩個都要過 */
class DistributorPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('distributors.manage');
    }

    public function view(User $user, Distributor $distributor): bool
    {
        return $user->can('distributors.manage') && $user->managesDistributor($distributor);
    }

    public function create(User $user): bool
    {
        return $user->can('distributors.manage');
    }

    public function update(User $user, Distributor $distributor): bool
    {
        return $user->can('distributors.manage') && $user->managesDistributor($distributor);
    }

    public function delete(User $user, Distributor $distributor): bool
    {
        return $user->can('distributors.manage') && $user->managesDistributor($distributor);   // 有訂單的由畫面拒絕，改成停權
    }
}
