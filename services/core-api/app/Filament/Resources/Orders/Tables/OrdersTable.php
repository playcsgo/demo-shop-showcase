<?php

namespace App\Filament\Resources\Orders\Tables;

use App\Enums\OrderStatus;
use App\Filament\Support\BrandScope;
use Filament\Actions\ViewAction;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

class OrdersTable
{
    public static function statusColor(?OrderStatus $s): string
    {
        return match ($s) {
            OrderStatus::Completed => 'success',
            OrderStatus::Paid, OrderStatus::Fulfilling => 'info',
            OrderStatus::PartiallyRefunded, OrderStatus::Refunded => 'warning',
            OrderStatus::PaymentFailed, OrderStatus::Cancelled => 'danger',
            default => 'gray',
        };
    }

    public static function configure(Table $table): Table
    {
        return $table
            ->defaultSort('id', 'desc')
            ->poll('5s') // demo：混沌測試時即時看到狀態變化
            ->columns([
                TextColumn::make('order_no')->label('訂單編號')->searchable()->copyable(),
                TextColumn::make('status')->label('狀態')->badge()->color(fn ($state) => self::statusColor($state)),
                TextColumn::make('brands')->label('品牌')->badge()
                    ->state(function ($record) {
                        $scope = BrandScope::user()->brandScope();

                        return $record->items->filter(fn ($i) => $scope === null || in_array($i->brand_id, $scope, true))
                            ->pluck('brand.project_code')->unique()->values()->all();
                    }),
                TextColumn::make('customer.name')->label('顧客'),
                TextColumn::make('total')->label('金額')->money('TWD', decimalPlaces: 0),
                TextColumn::make('utm_source')->label('來源')->placeholder('—')->toggleable(isToggledHiddenByDefault: true),
                TextColumn::make('created_at')->label('下單時間')->dateTime('m/d H:i:s')->sortable(),
            ])
            ->filters([
                SelectFilter::make('status')->label('狀態')
                    ->options(collect(OrderStatus::cases())->mapWithKeys(fn ($c) => [$c->value => $c->value])->all()),
            ])
            ->recordActions([ViewAction::make()]);
    }
}
