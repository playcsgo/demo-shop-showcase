<?php

namespace App\Domain\Distribution;

use App\Domain\DomainException;
use App\Models\ContractTemplate;
use App\Models\ContractTemplateItem;
use App\Models\Distributor;
use App\Models\DistributorContract;
use App\Models\User;

/** 把範本複製成草稿。複製不是參照：之後改範本，不影響已帶入的合約 */
class ContractTemplateApplier
{
    public function __construct(private ContractDrafts $drafts) {}

    public function apply(ContractTemplate $template, Distributor $distributor, User $by): DistributorContract
    {
        if ($template->owner_user_id !== $by->id) {
            throw new DomainException('template_not_found', '找不到這個範本', 404);   // 不透露別人的範本存在
        }
        if ($template->currency !== $distributor->currency) {
            throw new DomainException('currency_mismatch', "範本幣別是 {$template->currency}，經銷商是 {$distributor->currency}");
        }

        return $this->drafts->create($distributor, $template->only('prepay_bps', 'early_bird_discount_bps', 'min_lead_days') + [
            'incoterm' => $template->incoterm->value,
            'items' => $template->items->map(fn (ContractTemplateItem $i) => $i->only('product_id', 'moq_cases', 'case_size', 'case_multiple', 'tiers'))->all(),
        ], $template->id);
    }
}
