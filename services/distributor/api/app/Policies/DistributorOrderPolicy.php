<?php

namespace App\Policies;

use App\Models\DistributorOrder;
use App\Models\User;

/** 負責的業務＋distributor_orders.review，和批次相同。訂單不能在後台新增、修改、刪除 */
class DistributorOrderPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('distributor_orders.review');
    }

    public function view(User $user, DistributorOrder $order): bool
    {
        return $this->fulfil($user, $order);
    }

    public function fulfil(User $user, DistributorOrder $order): bool
    {
        return $user->can('distributor_orders.review') && $user->managesDistributor($order->loadMissing('shop.distributor')->shop->distributor);
    }

    public function create(User $user): bool
    {
        return false;
    }

    public function update(User $user, DistributorOrder $order): bool
    {
        return false;
    }

    public function delete(User $user, DistributorOrder $order): bool
    {
        return false;
    }
}
