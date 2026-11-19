<?php

namespace App\Filament\Resources\SettlementStatements\Tables;

use Filament\Actions\ViewAction;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;

class SettlementStatementsTable
{
    public static function configure(Table $table): Table
    {
        $money = fn (string $name, string $label) => TextColumn::make($name)->label($label)->money('TWD', decimalPlaces: 0);

        return $table
            ->defaultSort('period', 'desc')
            ->columns([
                TextColumn::make('legalEntity.name')->label('供應商'),
                TextColumn::make('period')->label('月份'),
                TextColumn::make('status')->label('狀態')->badge()
                    ->color(fn ($state) => ['DRAFT' => 'gray', 'CONFIRMED' => 'info', 'PAID' => 'success'][$state] ?? 'gray'),
                $money('gross', '銷售'),
                $money('refunds', '退款'),
                $money('commission', '抽成'),
                $money('fees', '金流手續費'),
                $money('payable', '應付')->weight('bold'),
                TextColumn::make('supplier_invoice_no')->label('供應商發票')->placeholder('—'),
            ])
            ->recordActions([ViewAction::make()]);
    }
}
