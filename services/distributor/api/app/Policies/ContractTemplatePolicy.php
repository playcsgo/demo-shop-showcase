<?php

namespace App\Policies;

use App\Models\ContractTemplate;
use App\Models\User;

/** 範本只屬於建立它的業務，super_admin 也一樣：這是個人的預設值，不是公司的資料 */
class ContractTemplatePolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('distributors.manage');
    }

    public function view(User $user, ContractTemplate $template): bool
    {
        return $user->can('distributors.manage') && $template->owner_user_id === $user->id;
    }

    public function create(User $user): bool
    {
        return $user->can('distributors.manage');
    }

    public function update(User $user, ContractTemplate $template): bool
    {
        return $this->view($user, $template);
    }

    public function delete(User $user, ContractTemplate $template): bool
    {
        return $this->view($user, $template);   // 已帶入的合約是複製的，刪範本不影響
    }
}
