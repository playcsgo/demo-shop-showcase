<?php

namespace App\Filament\Resources\ContractTemplates\Pages\Concerns;

use App\Domain\Distribution\ContractValidator;
use App\Domain\DomainException;
use App\Models\ContractTemplate;
use Filament\Notifications\Notification;
use Illuminate\Support\Facades\DB;

/** 範本的存檔：先過和合約相同的檢查，再整份替換品項 */
trait SavesTemplateItems
{
    /** @param  array<string, mixed>  $data */
    private function saveTemplate(ContractTemplate $template, array $data): ContractTemplate
    {
        try {
            app(ContractValidator::class)->assertValid($data);
        } catch (DomainException $e) {
            Notification::make()->danger()->title('無法存檔')->body($e->getMessage())->send();
            $this->halt();
        }

        DB::transaction(function () use ($template, $data) {
            $template->fill(collect($data)->except('items')->all())->save();
            $template->items()->delete();
            foreach ($data['items'] as $item) {
                $template->items()->create(collect($item)->only('product_id', 'moq_cases', 'case_size', 'case_multiple', 'tiers')->all());
            }
        });

        return $template;
    }
}
