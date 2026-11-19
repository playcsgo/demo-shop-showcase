<?php

namespace App\Filament\Resources\Products;

use App\Enums\TemperatureClass;
use App\Filament\Resources\Products\Pages\CreateProduct;
use App\Filament\Resources\Products\Pages\EditProduct;
use App\Filament\Resources\Products\Pages\ListProducts;
use App\Models\Product;
use BackedEnum;
use Filament\Actions\DeleteAction;
use Filament\Actions\EditAction;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

/** 經銷商自己的商品和庫存，和商店分開 */
class ProductResource extends Resource
{
    protected static ?string $model = Product::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedCube;

    protected static ?string $modelLabel = '商品';

    protected static ?int $navigationSort = 3;

    public const TEMPERATURES = ['ambient' => '常溫', 'chilled' => '冷藏', 'frozen' => '冷凍'];

    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()->with('inventory');
    }

    public static function form(Schema $schema): Schema
    {
        return $schema->columns(2)->components([
            TextInput::make('sku')->label('SKU')->required()->maxLength(40)->unique(ignoreRecord: true)
                ->disabledOn('edit')->helperText('建立後不能修改'),
            TextInput::make('name')->label('中文名稱')->required()->maxLength(255),
            Select::make('temperature_class')->label('溫層')->options(self::TEMPERATURES)->default(TemperatureClass::Ambient->value)->required(),
            TextInput::make('hs_code')->label('HS code')->maxLength(20)->helperText('預設值，各國可另外覆蓋；只供參考'),
            // 下單時拿來比對國家禁令；沒填會提醒無法檢查，非食品要標記不含成分
            Select::make('ingredients')->label('成分')->relationship('ingredients', 'name')->multiple()->preload()
                ->createOptionForm([TextInput::make('name')->label('成分名稱')->required()->maxLength(50)->unique('ingredients', 'name')]),
            Toggle::make('no_ingredients')->label('不含成分（非食品）'),
            // 庫存不是商品的欄位：不跟著存，存檔後用「增減」套用（EditProduct）
            TextInput::make('stock_change')->label('增減庫存')->integer()->placeholder('+入庫／−盤損')->dehydrated(false)
                ->helperText(fn (?Product $record) => $record ? "在庫 {$record->inventory->on_hand}，已預留 {$record->inventory->reserved}，可賣 {$record->inventory->available()}" : null)
                ->visibleOn('edit'),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->defaultSort('sku')
            ->columns([
                TextColumn::make('sku')->label('SKU')->searchable(),
                TextColumn::make('name')->label('中文名稱')->searchable(),
                TextColumn::make('temperature_class')->label('溫層')->formatStateUsing(fn (TemperatureClass $state) => self::TEMPERATURES[$state->value]),
                TextColumn::make('hs_code')->label('HS code')->placeholder('缺'),
                TextColumn::make('inventory.on_hand')->label('在庫'),
                TextColumn::make('inventory.reserved')->label('已預留'),
            ])
            ->recordActions([
                EditAction::make(),
                // 有訂單就拒絕，歷史訂單要完整；資料庫的 RESTRICT 外鍵是最後防線
                DeleteAction::make()
                    ->modalDescription('會連帶刪除這個 SKU 的合約品項、範本品項、顯示設定、各國 HS code、成分和庫存，無法復原。已有訂單的 SKU 不能刪除。')
                    ->failureNotificationTitle('這個 SKU 已有訂單，不能刪除')
                    ->using(fn (Product $record) => ! $record->hasOrderHistory() && $record->delete()),
            ]);
    }

    public static function getPages(): array
    {
        return [
            'index' => ListProducts::route('/'),
            'create' => CreateProduct::route('/create'),
            'edit' => EditProduct::route('/{record}/edit'),
        ];
    }
}
