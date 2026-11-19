<?php

namespace App\Filament\Support;

use App\Models\Product;
use Filament\Forms\Components\Repeater;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;

/**
 * 範本和合約共用的欄位。Repeater 不綁 relationship：整份交給 Domain 檢查和替換，規則才不會散在畫面裡。
 * 比例填萬分比（3000 = 30%），金額填最小單位（TWD、JPY 是元，其他是分）：和資料庫一樣，不用換算就不會有小數誤差
 */
class ContractTermsForm
{
    /** @return array<int, string> 設定價格時同時看到 SKU 和中文名稱 */
    public static function productOptions(): array
    {
        return Product::orderBy('sku')->get(['id', 'sku', 'name'])->mapWithKeys(fn (Product $p) => [$p->id => "{$p->sku} {$p->name}"])->all();
    }

    /** @return array<int, mixed> */
    public static function fields(): array
    {
        return [
            Select::make('incoterm')->label('Incoterm')->options(['FOB' => 'FOB', 'CIF' => 'CIF'])->required(),
            TextInput::make('prepay_bps')->label('預付比例（萬分比）')->helperText('3000 = 30%')->integer()->minValue(0)->maxValue(10000)->required(),
            TextInput::make('early_bird_discount_bps')->label('早鳥折扣（萬分比）')->helperText('300 = 3%')->integer()->minValue(0)->maxValue(10000)->required(),
            TextInput::make('min_lead_days')->label('早鳥最短交期（天）')->integer()->minValue(0)->required(),
            Repeater::make('items')->label('允許的商品')->columnSpanFull()->columns(4)->defaultItems(0)->schema([
                Select::make('product_id')->label('商品')->required()->searchable()
                    ->options(fn () => self::productOptions()),
                TextInput::make('moq_cases')->label('MOQ（箱）')->integer()->minValue(1)->required(),
                TextInput::make('case_size')->label('每箱件數')->integer()->minValue(1)->required(),
                TextInput::make('case_multiple')->label('箱數倍數')->integer()->minValue(1)->default(1)->required(),
                Repeater::make('tiers')->label('階梯價（第一階從 1 箱開始）')->columnSpanFull()->columns(2)->defaultItems(1)->schema([
                    TextInput::make('min_cases')->label('幾箱以上')->integer()->minValue(1)->required(),
                    TextInput::make('unit_price_minor')->label('單價（最小單位：TWD、JPY 是元，其他是分）')->integer()->minValue(1)->required(),
                ]),
            ]),
        ];
    }
}
