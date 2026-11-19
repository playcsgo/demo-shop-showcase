<?php

namespace App\Filament\Pages;

use App\Domain\Reports\BrandRevenue;
use App\Filament\Support\BrandScope;
use BackedEnum;
use Filament\Pages\Page;
use Filament\Schemas\Components\EmbeddedTable;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\Summarizers\Sum;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Concerns\InteractsWithTable;
use Filament\Tables\Contracts\HasTable;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;
use Illuminate\Support\Carbon;

/**
 * 財報：每個品牌一列（reports.view）。看得到哪些品牌跟其他頁一樣由 brandScope 決定：
 * admin／finance 全部；operator 自己法人底下的所有品牌；品牌經理只有被指派的品牌。
 */
class FinancialReport extends Page implements HasTable
{
    use InteractsWithTable;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedChartBar;

    protected static ?string $title = '財報';

    protected static ?int $navigationSort = 4;

    public static function canAccess(): bool
    {
        return auth()->user()?->can('reports.view') ?? false;
    }

    public function content(Schema $schema): Schema
    {
        return $schema->components([EmbeddedTable::make()]);
    }

    public function period(): string
    {
        return $this->getTableFilterState('period')['value'] ?? now()->format('Y-m');
    }

    public function table(Table $table): Table
    {
        $money = fn (string $name, string $label) => TextColumn::make($name)->label($label)->money('TWD', decimalPlaces: 0)
            ->summarize(Sum::make()->label('')->money('TWD', decimalPlaces: 0));
        $seesAll = BrandScope::user()->brandScope() === null;

        return $table
            ->query(fn () => app(BrandRevenue::class)->query($this->period(), BrandScope::user()->brandScope()))
            ->heading(fn () => "{$this->period()} 財報")
            ->description(fn () => $seesAll
                ? '汪的總收入（汪品牌淨收入＋喵付的抽成）：NT$ '.number_format(app(BrandRevenue::class)->platformIncome($this->period()))
                : null)
            ->columns([
                TextColumn::make('legal_entity_name')->label('法人'),
                TextColumn::make('project_code')->label('品牌')->badge()
                    ->formatStateUsing(fn ($state, $record) => "{$state} {$record->name}"),
                $money('gross', '銷售'),
                $money('refunds', '退款'),
                $money('fees', '金流手續費'),
                $money('commission', '抽成（付給汪）'),
                $money('net_income', '品牌淨收入')->weight('bold'),
            ])
            ->filters([
                SelectFilter::make('period')->label('月份')
                    ->options(collect(range(0, 11))->mapWithKeys(fn ($i) => [$p = Carbon::now()->startOfMonth()->subMonths($i)->format('Y-m') => $p])->all())
                    ->default(now()->format('Y-m'))->selectablePlaceholder(false)
                    ->query(fn ($query) => $query),   // 月份已在 BrandRevenue 裡套用
            ])
            ->paginated(false);
    }
}
