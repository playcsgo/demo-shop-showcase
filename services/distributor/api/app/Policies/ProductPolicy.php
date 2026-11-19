<?php

namespace App\Policies;

use App\Models\Product;
use App\Models\User;

/** 商品全公司共用。商品頁給商品管理；業務的「商品 HS code」頁另外用規則權限 */
class ProductPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('products.manage');
    }

    public function view(User $user, Product $product): bool
    {
        return $user->can('products.manage');
    }

    public function create(User $user): bool
    {
        return $user->can('products.manage');
    }

    public function update(User $user, Product $product): bool
    {
        return $user->can('products.manage');
    }

    public function delete(User $user, Product $product): bool
    {
        return $user->can('products.manage');
    }
}
