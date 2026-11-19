<?php

namespace App\Filament\Resources\Products\Pages\Concerns;

use App\Domain\Catalog\InventoryBuckets;
use App\Domain\Catalog\InventoryService;
use App\Domain\DomainException;
use Filament\Notifications\Notification;

/**
 * 商品存檔之後，把表單上每個規格的「庫存／增減庫存」套用到 inventory 表。
 * 一律用增減（InventoryService::adjust 的條件式 UPDATE），不直接覆寫數量：避免蓋掉同時間訂單扣掉的庫存。
 * 新商品的「庫存」就是從 0 增加。
 *
 * 要在存檔「之前」先記下來：存檔時 Filament 會從資料庫重新載入規格的欄位，
 * 「增減庫存」不是資料庫欄位，存完就被清掉了（實際踩到）。
 * 「熱賣模式」也一樣：存檔後改想要的桶數（InventoryBuckets::setHot），實際拆／併由排程做。
 */
trait AppliesStockChanges
{
    /** @var array<string, int> sku → 增減 */
    protected array $pendingStockChanges = [];

    /** @var array<string, bool> sku → 熱賣模式 */
    protected array $pendingHotModes = [];

    protected function rememberStockChanges(): void
    {
        $this->pendingStockChanges = collect($this->data['variants'] ?? [])
            ->filter(fn (array $item) => filled($item['sku'] ?? null) && (int) ($item['stock_change'] ?? 0) !== 0)
            ->mapWithKeys(fn (array $item) => [$item['sku'] => (int) $item['stock_change']])
            ->all();
        $this->pendingHotModes = collect($this->data['variants'] ?? [])
            ->filter(fn (array $item) => filled($item['sku'] ?? null) && array_key_exists('hot', $item))
            ->mapWithKeys(fn (array $item) => [$item['sku'] => (bool) $item['hot']])
            ->all();
    }

    protected function applyStockChanges(): void
    {
        $inventory = app(InventoryService::class);

        foreach ($this->pendingStockChanges as $sku => $delta) {
            $variant = $this->record->variants()->where('sku', $sku)->first();
            if (! $variant || $variant->isService()) {
                continue;
            }

            try {
                $inventory->adjust($variant->id, $delta);
            } catch (DomainException $e) {
                Notification::make()->danger()->title("{$sku} 的庫存沒有調整")->body($e->getMessage())->persistent()->send();
            }
        }

        $this->pendingStockChanges = [];

        foreach ($this->pendingHotModes as $sku => $on) {
            $variant = $this->record->variants()->where('sku', $sku)->first();
            if ($variant && ! $variant->isService()) {
                app(InventoryBuckets::class)->setHot($variant, $on);
            }
        }
        $this->pendingHotModes = [];
    }
}
