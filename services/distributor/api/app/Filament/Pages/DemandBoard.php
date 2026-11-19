<?php

namespace App\Filament\Pages;

use App\Domain\Distribution\DemandBoard as Board;
use App\Enums\TemperatureClass;
use BackedEnum;
use Filament\Actions\Action;
use Filament\Infolists\Components\TextEntry;
use Filament\Pages\Page;
use Filament\Schemas\Components\EmbeddedTable;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Concerns\InteractsWithTable;
use Filament\Tables\Contracts\HasTable;
use Filament\Tables\Table;
use Symfony\Component\HttpFoundation\StreamedResponse;

/** 需求合併看板（demand_board.view）：每個 SKU 每個出貨月份的合計件數，點開看是哪些單，可以匯出 CSV */
class DemandBoard extends Page implements HasTable
{
    use InteractsWithTable;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedQueueList;

    protected static ?string $title = '需求合併看板';

    protected static ?int $navigationSort = 8;

    protected static ?string $slug = 'demand-board';

    public static function canAccess(): bool
    {
        return auth()->user()?->can('demand_board.view') ?? false;
    }

    public function content(Schema $schema): Schema
    {
        return $schema->components([EmbeddedTable::make()]);
    }

    public function table(Table $table): Table
    {
        return $table
            ->records(fn () => collect(app(Board::class)->rows())->keyBy(fn (array $r) => "{$r['ship_month']}:{$r['product_id']}")->all())
            ->paginated(false)
            ->emptyStateHeading('目前沒有要排產的訂單')
            ->columns([
                TextColumn::make('ship_month')->label('出貨月份'),
                TextColumn::make('sku')->label('SKU'),
                TextColumn::make('name')->label('商品'),
                TextColumn::make('temperature_class')->label('溫層')->badge()
                    ->state(fn (array $record) => $record['temperature_class'] === TemperatureClass::Ambient->value ? null : $record['temperature_class'])   // 常溫是預設，不特別顯示
                    ->color(fn (string $state) => $state === TemperatureClass::Frozen->value ? 'info' : 'primary'),
                TextColumn::make('total_units')->label('合計件數')->numeric()->weight('bold'),
                TextColumn::make('order_count')->label('訂單數'),
            ])
            ->headerActions([
                Action::make('export')->label('匯出 CSV')
                    ->action(fn (): StreamedResponse => response()->streamDownload(function () {
                        $out = fopen('php://output', 'w');
                        app(Board::class)->writeCsv($out);
                        fclose($out);
                    }, 'demand-board-'.now('Asia/Taipei')->format('Ymd').'.csv', ['Content-Type' => 'text/csv; charset=UTF-8'])),
            ])
            ->recordActions([
                Action::make('details')->label('看訂單')->color('gray')->modalSubmitAction(false)
                    ->schema(fn (array $record) => [
                        TextEntry::make('orders')->hiddenLabel()->listWithLineBreaks()->state(array_map(
                            fn (array $d) => "{$d['order_no']}　{$d['distributor_name']}／{$d['shop_name']}　{$d['qty_cases']} 箱（{$d['qty_units']} 件）　交期 {$d['requested_ship_date']}",
                            app(Board::class)->details($record['ship_month'], $record['product_id']),
                        )),
                    ]),
            ]);
    }
}
