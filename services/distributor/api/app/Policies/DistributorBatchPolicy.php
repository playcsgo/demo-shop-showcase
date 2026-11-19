<?php

namespace App\Policies;

use App\Models\DistributorBatch;
use App\Models\User;

/** 負責的業務＋distributor_orders.review。批次不能在後台新增、修改、刪除：只能由經銷商送出、由審核動作推進 */
class DistributorBatchPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('distributor_orders.review');
    }

    public function view(User $user, DistributorBatch $batch): bool
    {
        return $this->review($user, $batch);
    }

    public function review(User $user, DistributorBatch $batch): bool
    {
        return $user->can('distributor_orders.review') && $user->managesDistributor($batch->loadMissing('distributor')->distributor);
    }

    public function create(User $user): bool
    {
        return false;
    }

    public function update(User $user, DistributorBatch $batch): bool
    {
        return false;
    }

    public function delete(User $user, DistributorBatch $batch): bool
    {
        return false;
    }
}
