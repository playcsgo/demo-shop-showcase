<?php

namespace App\Policies;

use App\Models\DistributorContract;
use App\Models\User;

/** 權限跟著經銷商走 */
class DistributorContractPolicy
{
    public function view(User $user, DistributorContract $contract): bool
    {
        return $user->can('distributors.manage') && $user->managesDistributor($contract->loadMissing('distributor')->distributor);
    }

    public function update(User $user, DistributorContract $contract): bool
    {
        return $this->view($user, $contract);
    }

    public function delete(User $user, DistributorContract $contract): bool
    {
        return false;   // 舊版要保留；不要的草稿直接改掉
    }
}
