<?php

namespace App\Policies;

use App\Models\Order;
use App\Models\User;

class OrderPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('orders.view');
    }

    /** 訂單裡至少有一項是自己品牌的，才看得到（混合訂單也只看得到自己品牌的明細） */
    public function view(User $user, Order $order): bool
    {
        $scope = $user->brandScope();

        return $user->can('orders.view') && ($scope === null || $order->items()->whereIn('brand_id', $scope)->exists());
    }

    public function create(User $user): bool
    {
        return false; // 訂單只能由顧客結帳產生
    }

    public function update(User $user, Order $order): bool
    {
        return false; // 狀態只能由流程推進（Saga），後台不能直接改
    }

    public function delete(User $user, Order $order): bool
    {
        return false;
    }

    public function refund(User $user, Order $order): bool
    {
        return $user->can('orders.refund') && $this->view($user, $order);
    }
}
