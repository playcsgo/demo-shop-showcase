<?php

namespace App\Domain\Distribution;

use App\Domain\DomainException;
use App\Enums\ContractStatus;
use App\Models\Distributor;
use App\Models\DistributorContract;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/** 生效：檢查、切換版本，同一個交易。禁令在下單時才掃描 */
class ContractActivator
{
    public function __construct(private ContractValidator $validator) {}

    public function activate(DistributorContract $contract, User $by): DistributorContract
    {
        return DB::transaction(function () use ($contract, $by) {
            // 鎖經銷商：兩個人同時按生效，後面那個等到前面完成，才看到已經不是草稿
            Distributor::whereKey($contract->distributor_id)->lockForUpdate()->sole();
            $fresh = DistributorContract::findOrFail($contract->id);
            if ($fresh->status !== ContractStatus::Draft) {
                throw new DomainException('contract_not_draft', '只有草稿可以生效', 409);
            }

            $terms = $fresh->toTerms();
            $this->validator->assertValid($terms);
            if ($terms['items'] === []) {
                throw new DomainException('contract_invalid', '合約至少要有一個品項');
            }

            DistributorContract::where('distributor_id', $fresh->distributor_id)->where('status', ContractStatus::Active)
                ->update(['status' => ContractStatus::Superseded]);
            $fresh->update(['status' => ContractStatus::Active, 'activated_by_user_id' => $by->id, 'activated_at' => now()]);

            return $fresh;
        });
    }
}
