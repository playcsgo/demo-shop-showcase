<?php

namespace App\Filament\Resources\Products\Schemas;

use Filament\Infolists\Components\ImageEntry;
use Filament\Infolists\Components\RepeatableEntry;
use Filament\Infolists\Components\TextEntry;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;

class ProductInfolist
{
    public static function configure(Schema $schema): Schema
    {
        return $schema->columns(1)->components([
            Section::make('商品')->columns(4)->schema([
                TextEntry::make('brand.name')->label('品牌'),
                TextEntry::make('name')->label('名稱'),
                TextEntry::make('status')->label('狀態')->badge(),
                TextEntry::make('delivery_modes')->label('交付方式')->badge()
                    ->formatStateUsing(fn ($state) => ProductForm::DELIVERY_MODES[$state] ?? $state),
                ImageEntry::make('image_path')->label('商品圖片')->disk('s3')->visibility('public')->checkFileExistence(false)
                    ->imageHeight(160)->placeholder('（沒有圖片）')->columnSpanFull(),
            ]),
            Section::make('規格、價格、庫存')->schema([
                RepeatableEntry::make('variants')->label('')->columns(6)->schema([
                    TextEntry::make('sku'),
                    TextEntry::make('price')->label('價格')->money('TWD', decimalPlaces: 0),
                    TextEntry::make('shipping_class')->label('運送類別')->badge(),
                    TextEntry::make('on_hand')->label('在庫')->state(fn ($record) => $record->stock()?->on_hand)->placeholder('—（服務）'),
                    TextEntry::make('reserved')->label('已預留')->state(fn ($record) => $record->stock()?->reserved)->placeholder('—'),
                    TextEntry::make('available')->label('可賣')
                        ->state(fn ($record) => $record->stock()?->available() ?? '不限'),
                    TextEntry::make('buckets')->label('熱賣模式')->state(fn ($record) => ProductForm::hotStatus($record))->placeholder('—'),
                ]),
            ]),
        ]);
    }
}
