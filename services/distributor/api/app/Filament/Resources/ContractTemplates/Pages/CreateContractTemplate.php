<?php

namespace App\Filament\Resources\ContractTemplates\Pages;

use App\Filament\Resources\ContractTemplates\ContractTemplateResource;
use App\Filament\Resources\ContractTemplates\Pages\Concerns\SavesTemplateItems;
use App\Models\ContractTemplate;
use Filament\Resources\Pages\CreateRecord;
use Illuminate\Database\Eloquent\Model;

class CreateContractTemplate extends CreateRecord
{
    use SavesTemplateItems;

    protected static string $resource = ContractTemplateResource::class;

    protected function handleRecordCreation(array $data): Model
    {
        return $this->saveTemplate(new ContractTemplate(['owner_user_id' => auth()->id()]), $data);
    }
}
