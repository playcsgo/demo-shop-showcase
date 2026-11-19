<?php

namespace App\Filament\Resources\Products\Pages;

use App\Filament\Resources\Products\Pages\Concerns\AppliesStockChanges;
use App\Filament\Resources\Products\ProductResource;
use Filament\Resources\Pages\CreateRecord;

class CreateProduct extends CreateRecord
{
    use AppliesStockChanges;

    protected static string $resource = ProductResource::class;

    protected function beforeCreate(): void
    {
        $this->rememberStockChanges();
    }

    protected function afterCreate(): void
    {
        $this->applyStockChanges();
    }
}
