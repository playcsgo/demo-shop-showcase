<?php

namespace App\Filament\Resources\ContractTemplates\Pages;

use App\Filament\Resources\ContractTemplates\ContractTemplateResource;
use App\Filament\Resources\ContractTemplates\Pages\Concerns\SavesTemplateItems;
use App\Models\ContractTemplate;
use Filament\Actions\DeleteAction;
use Filament\Resources\Pages\EditRecord;
use Illuminate\Database\Eloquent\Model;

class EditContractTemplate extends EditRecord
{
    use SavesTemplateItems;

    protected static string $resource = ContractTemplateResource::class;

    protected function mutateFormDataBeforeFill(array $data): array
    {
        /** @var ContractTemplate $template */
        $template = $this->record;

        return $data + ['items' => $template->items()->get()->map->only('product_id', 'moq_cases', 'case_size', 'case_multiple', 'tiers')->all()];
    }

    protected function handleRecordUpdate(Model $record, array $data): Model
    {
        /** @var ContractTemplate $record */
        return $this->saveTemplate($record, $data);
    }

    protected function getHeaderActions(): array
    {
        return [
            DeleteAction::make(),
        ];
    }
}
