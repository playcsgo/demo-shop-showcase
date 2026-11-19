<?php

namespace App\Filament\Resources\Products\Tables;

use App\Filament\Resources\Products\Schemas\ProductForm;
use App\Filament\Support\BrandScope;
use Filament\Actions\EditAction;
use Filament\Actions\ViewAction;
use Filament\Tables\Columns\ImageColumn;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

class ProductsTable
{
    public static function configure(Table $table): Table
    {
        return $table
            ->defaultSort(fn (Builder $query) => $query->orderByOwner())
            ->columns([
                ImageColumn::make('image_path')->label('圖片')->disk('s3')->visibility('public')->checkFileExistence(false)->square()->imageSize(48),
                TextColumn::make('brand.project_code')->label('品牌')->badge(),
                TextColumn::make('name')->label('名稱')->searchable(),
                TextColumn::make('price')->label('價格')->state(fn ($record) => $record->variants->first()?->price)->money('TWD', decimalPlaces: 0),
                TextColumn::make('available')->label('可賣')
                    ->state(fn ($record) => ($stock = $record->variants->first()?->stock()) ? $stock->available() : '不限'),
                TextColumn::make('delivery_modes')->label('交付方式')->badge()
                    ->formatStateUsing(fn ($state) => ProductForm::DELIVERY_MODES[$state] ?? $state),
                TextColumn::make('status')->label('狀態')->badge()
                    ->color(fn ($state) => $state === 'active' ? 'success' : 'gray'),
            ])
            ->filters([
                SelectFilter::make('brand_id')->label('品牌')->options(fn () => BrandScope::brandOptions()),
            ])
            ->recordActions([ViewAction::make(), EditAction::make()]);
    }
}
