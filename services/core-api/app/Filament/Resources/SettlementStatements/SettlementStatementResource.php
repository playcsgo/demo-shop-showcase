<?php

namespace App\Filament\Resources\SettlementStatements;

use App\Filament\Resources\SettlementStatements\Pages\ListSettlementStatements;
use App\Filament\Resources\SettlementStatements\Pages\ViewSettlementStatement;
use App\Filament\Resources\SettlementStatements\Schemas\SettlementStatementInfolist;
use App\Filament\Resources\SettlementStatements\Tables\SettlementStatementsTable;
use App\Filament\Resources\SettlementStatements\Widgets\UnsettledTotals;
use App\Filament\Support\BrandScope;
use App\Models\SettlementStatement;
use BackedEnum;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

/** 月結：汪 ↔ 喵（供應商）的結算單。金額只能由分錄產生，不能手改。 */
class SettlementStatementResource extends Resource
{
    protected static ?string $model = SettlementStatement::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedBanknotes;

    protected static ?string $modelLabel = '月結單';

    protected static ?int $navigationSort = 3;

    public static function getEloquentQuery(): Builder
    {
        return BrandScope::statements(parent::getEloquentQuery()->with('legalEntity'));
    }

    public static function infolist(Schema $schema): Schema
    {
        return SettlementStatementInfolist::configure($schema);
    }

    public static function table(Table $table): Table
    {
        return SettlementStatementsTable::configure($table);
    }

    public static function getWidgets(): array
    {
        return [UnsettledTotals::class];
    }

    public static function getPages(): array
    {
        return [
            'index' => ListSettlementStatements::route('/'),
            'view' => ViewSettlementStatement::route('/{record}'),
        ];
    }
}
