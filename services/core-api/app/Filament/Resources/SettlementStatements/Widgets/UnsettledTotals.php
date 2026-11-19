<?php

namespace App\Filament\Resources\SettlementStatements\Widgets;

use App\Filament\Support\BrandScope;
use App\Models\LegalEntity;
use App\Models\SettlementStatement;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Filament\Widgets\TableWidget;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Illuminate\Support\Facades\DB;

/**
 * 月結單要等「產生結算單」才有；在那之前，訂單的分錄已經記好了（statement_id 是 null）。
 * 這裡即時加總還沒結算的分錄，讓月中也看得到目前累計的應付金額。只讀，不會動到分錄。
 */
class UnsettledTotals extends TableWidget
{
    protected int|string|array $columnSpan = 'full';

    public static function canView(): bool
    {
        return auth()->user()?->can('viewAny', SettlementStatement::class) ?? false;
    }

    public function table(Table $table): Table
    {
        $unsettled = fn (?string $type = null) => fn (QueryBuilder $q) => $q->from('settlement_entries')
            ->whereColumn('settlement_entries.legal_entity_id', 'legal_entities.id')
            ->whereNull('statement_id')
            ->when($type, fn ($q) => $q->where('type', $type))
            ->selectRaw('COALESCE(SUM(amount), 0)');
        $money = fn (string $name, string $label) => TextColumn::make($name)->label($label)->money('TWD', decimalPlaces: 0);
        $scope = BrandScope::user()->legalEntityScope();

        return $table
            ->heading('未結算（累計至今，尚未產生結算單）')
            ->query(fn () => LegalEntity::query()
                ->where('role', 'supplier')
                ->when($scope !== null, fn ($q) => $q->whereIn('id', $scope))
                ->whereExists(fn (QueryBuilder $q) => $q->from('settlement_entries')
                    ->whereColumn('settlement_entries.legal_entity_id', 'legal_entities.id')->whereNull('statement_id'))
                ->select('legal_entities.*')
                ->selectSub($unsettled('SALE'), 'gross')
                ->selectSub($unsettled('REFUND'), 'refunds')
                ->selectSub($unsettled('COMMISSION'), 'commission')
                ->selectSub($unsettled('PAYMENT_FEE'), 'fees')
                ->selectSub($unsettled(), 'payable')
                ->selectSub(fn (QueryBuilder $q) => $q->from('settlement_entries')
                    ->whereColumn('settlement_entries.legal_entity_id', 'legal_entities.id')->whereNull('statement_id')
                    ->select(DB::raw('MIN(occurred_at)')), 'since'))
            ->columns([
                TextColumn::make('name')->label('供應商'),
                TextColumn::make('since')->label('最早一筆')->date('Y-m-d'),
                $money('gross', '銷售'),
                $money('refunds', '退款'),
                $money('commission', '抽成'),
                $money('fees', '金流手續費'),
                $money('payable', '應付（預估）')->weight('bold'),
            ])
            ->paginated(false)
            ->emptyStateHeading('沒有未結算的分錄');
    }
}
