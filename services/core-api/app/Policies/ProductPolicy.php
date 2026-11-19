<?php

namespace App\Policies;

use App\Models\Product;
use App\Models\User;

/**
 * Policy＝「這個人能不能對這筆資料做這件事」。
 * RBAC（有沒有權限）＋ ABAC（這筆資料的品牌在不在他的範圍內），兩個都要過。
 * Filament 會自動呼叫：列表 viewAny、檢視 view、新增 create、編輯 update、刪除 delete。
 */
class ProductPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('products.view');
    }

    public function view(User $user, Product $product): bool
    {
        return $user->can('products.view') && $user->canAccessBrand($product->brand_id);
    }

    public function create(User $user): bool
    {
        return $user->can('products.manage');
    }

    public function update(User $user, Product $product): bool
    {
        return $user->can('products.manage') && $user->canAccessBrand($product->brand_id);
    }

    public function delete(User $user, Product $product): bool
    {
        return false; // 有訂單參照，不實體刪除；改用下架（status = inactive）
    }
}
