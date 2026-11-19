<?php

namespace App\Filament\Resources\Products\Pages;

use App\Filament\Resources\Products\Pages\Concerns\AppliesStockChanges;
use App\Filament\Resources\Products\ProductResource;
use Filament\Actions\DeleteAction;
use Filament\Actions\ViewAction;
use Filament\Resources\Pages\EditRecord;

class EditProduct extends EditRecord
{
    use AppliesStockChanges;

    protected static string $resource = ProductResource::class;

    protected function beforeSave(): void
    {
        $this->rememberStockChanges();
    }

    protected function afterSave(): void
    {
        $this->applyStockChanges();
        // 重新載入表單：顯示最新的庫存，增減欄位清空
        $this->record->load('variants.buckets');
        $this->fillForm();
    }

    protected function getHeaderActions(): array
    {
        return [
            ViewAction::make(),
            DeleteAction::make(),
        ];
    }
}
