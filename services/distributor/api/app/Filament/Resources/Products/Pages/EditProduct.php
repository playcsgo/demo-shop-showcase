<?php

namespace App\Filament\Resources\Products\Pages;

use App\Domain\Catalog\InventoryService;
use App\Domain\DomainException;
use App\Filament\Resources\Products\ProductResource;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\EditRecord;

class EditProduct extends EditRecord
{
    protected static string $resource = ProductResource::class;

    /** 用增減套用庫存，才不會蓋掉同一時間的預留。存完清空欄位，顯示最新數字 */
    protected function afterSave(): void
    {
        $delta = (int) ($this->data['stock_change'] ?? 0);
        try {
            app(InventoryService::class)->adjust($this->record->getKey(), $delta);
        } catch (DomainException $e) {
            Notification::make()->danger()->title('庫存沒有調整')->body($e->getMessage())->persistent()->send();
        }
        $this->record->load('inventory');
        $this->fillForm();
    }
}
