<?php

namespace App\Filament\Resources\Distributors\Pages;

use App\Filament\Resources\Distributors\DistributorResource;
use Filament\Resources\Pages\CreateRecord;

class CreateDistributor extends CreateRecord
{
    protected static string $resource = DistributorResource::class;

    /** 業務沒有「負責業務」這欄：掛在自己名下 */
    protected function mutateFormDataBeforeCreate(array $data): array
    {
        return $data + ['sales_user_id' => auth()->id()];
    }
}
