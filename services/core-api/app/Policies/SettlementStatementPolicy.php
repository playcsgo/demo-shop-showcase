<?php

namespace App\Policies;

use App\Models\SettlementStatement;
use App\Models\User;

class SettlementStatementPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('settlements.view');
    }

    public function view(User $user, SettlementStatement $s): bool
    {
        $scope = $user->legalEntityScope();

        return $user->can('settlements.view') && ($scope === null || in_array($s->legal_entity_id, $scope, true));
    }

    public function create(User $user): bool
    {
        return false; // 用「產生結算單」動作，不手動建立
    }

    public function update(User $user, SettlementStatement $s): bool
    {
        return false; // 結算單只能由分錄產生，不能手改金額
    }

    public function delete(User $user, SettlementStatement $s): bool
    {
        return false;
    }

    public function manage(User $user): bool
    {
        return $user->can('settlements.manage');
    }
}
