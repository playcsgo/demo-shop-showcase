<?php

namespace App\Filament\Resources\DistributorBatches\RelationManagers;

use App\Domain\Distribution\Money;
use App\Filament\Resources\DistributorOrders\DistributorOrderResource;
use App\Models\DistributorOrder;
use Filament\Resources\RelationManagers\RelationManager;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;

/** 批次頁上的各 shop 訂單：業務在這裡填 ETA、出貨、送達，品項點單號看 */
class OrdersRelationManager extends RelationManager
{
    protected static string $relationship = 'orders';

    protected static ?string $title = '訂單';

    protected static bool $isLazy = false;

    public function isReadOnly(): bool
    {
        return false;
    }

    public function table(Table $table): Table
    {
        return $table
            ->modelLabel('訂單')
            ->modifyQueryUsing(fn ($query) => $query->with('shop.distributor', 'batch'))
            ->defaultSort('id')
            ->paginated(false)
            // 傳單號不傳 model：model 會變成 id，但明細頁是用單號找訂單，id 會 404
            ->recordUrl(fn (DistributorOrder $record) => DistributorOrderResource::getUrl('view', ['record' => $record->order_no]))
            ->columns([
                TextColumn::make('order_no')->label('單號')->color('primary'),
                TextColumn::make('shop.name')->label('Shop'),
                TextColumn::make('status')->label('狀態')->badge()->formatStateUsing(fn ($state, DistributorOrder $record) => DistributorOrderResource::statusLabel($record)),
                TextColumn::make('subtotal_minor')->label('金額')->formatStateUsing(fn (int $state, DistributorOrder $record) => Money::format($state, $record->batch->currency)),
                TextColumn::make('eta_date')->label('ETA')->date('Y-m-d')->placeholder('未填'),
            ])
            ->recordActions(DistributorOrderResource::fulfilmentActions());
    }
}
