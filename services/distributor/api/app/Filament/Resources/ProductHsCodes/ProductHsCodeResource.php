<?php

namespace App\Filament\Resources\ProductHsCodes;

use App\Domain\Distribution\CountryRuleService;
use App\Filament\Resources\ProductHsCodes\Pages\ListProductHsCodes;
use App\Filament\Support\DistributorScope;
use App\Models\DistributorShop;
use App\Models\Product;
use App\Models\ProductCountryRule;
use App\Models\ProductCountryRuleChange;
use BackedEnum;
use Filament\Actions\Action;
use Filament\Forms\Components\TextInput;
use Filament\Infolists\Components\RepeatableEntry;
use Filament\Infolists\Components\TextEntry;
use Filament\Resources\Resource;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Contracts\HasTable;
use Filament\Tables\Enums\FiltersLayout;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

/**
 * 選一個國家，列出所有商品在那個國家的 HS code。國家有值就用國家的，沒有才用 SKU 的預設。
 * 只供參考，最終以貨代為準。全公司共用，每次改動都留紀錄
 */
class ProductHsCodeResource extends Resource
{
    public const DEFAULT_COUNTRY = 'TW';

    protected static ?string $model = Product::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedGlobeAsiaAustralia;

    protected static ?string $navigationLabel = '商品 HS code';

    protected static ?string $modelLabel = '商品 HS code';

    protected static ?string $pluralModelLabel = '商品 HS code';

    protected static ?string $breadcrumb = '商品 HS code';

    protected static ?int $navigationSort = 7;

    protected static ?string $slug = 'product-hs-codes';

    /** 看的是規則權限，不是商品權限：業務沒有商品頁，也要能維護各國的值 */
    public static function canAccess(): bool
    {
        return (bool) auth()->user()?->can('country_rules.manage');
    }

    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()->with('countryRules');
    }

    public static function table(Table $table): Table
    {
        return $table
            ->defaultSort('sku')
            ->deferFilters(false)
            ->columns([
                TextColumn::make('sku')->label('SKU')->searchable(),
                TextColumn::make('name')->label('商品'),
                TextColumn::make('effective_hs_code')->label('HS code')->placeholder('缺')
                    ->state(fn (Product $record, HasTable $livewire) => self::countryValue($record, $livewire) ?? $record->hs_code)
                    ->description(fn (Product $record, HasTable $livewire) => match (true) {
                        self::countryValue($record, $livewire) !== null => '這個國家的值',
                        $record->hs_code !== null => 'SKU 預設',
                        default => null,
                    }),
            ])
            ->filters([
                SelectFilter::make('country')->label('國家')->options(DistributorShop::COUNTRIES)
                    ->default(self::DEFAULT_COUNTRY)->selectablePlaceholder(false)->indicateUsing(fn () => [])
                    ->query(fn (Builder $query) => $query),   // 不篩列：所有商品都列出來，國家只決定顯示哪個值
            ], layout: FiltersLayout::AboveContent)
            ->recordActions([
                Action::make('history')->label('紀錄')->color('gray')->icon(Heroicon::OutlinedClock)
                    ->modalHeading(fn (Product $record, HasTable $livewire) => self::heading($record, $livewire).'的變更紀錄')
                    ->modalSubmitAction(false)->modalCancelActionLabel('關閉')
                    ->schema(fn (Product $record, HasTable $livewire) => [
                        RepeatableEntry::make('history')->hiddenLabel()->columns(4)->placeholder('還沒有改過')
                            ->state(ProductCountryRuleChange::with('changedBy')->where('product_id', $record->id)->where('country_code', self::country($livewire))
                                ->latest('id')->get()->map(fn (ProductCountryRuleChange $c) => [
                                    'who' => $c->changedBy->name,
                                    'when' => $c->created_at->timezone('Asia/Taipei')->format('Y-m-d H:i'),
                                    'before' => $c->before['hs_code'] ?? '（沒有）',
                                    'after' => $c->after['hs_code'] ?? '（還原 SKU 預設）',
                                ])->all())
                            ->schema([
                                TextEntry::make('who')->label('誰'),
                                TextEntry::make('when')->label('何時'),
                                TextEntry::make('before')->label('改前'),
                                TextEntry::make('after')->label('改後'),
                            ]),
                    ]),
                Action::make('editHsCode')->label('編輯')->icon(Heroicon::OutlinedPencilSquare)
                    ->modalHeading(fn (Product $record, HasTable $livewire) => self::heading($record, $livewire).'的 HS code')
                    ->fillForm(fn (Product $record, HasTable $livewire) => ['hs_code' => self::countryValue($record, $livewire) ?? $record->hs_code])
                    ->schema([
                        TextInput::make('hs_code')->label('HS code')->required()->maxLength(20)->helperText('海關判定改變時直接覆蓋。只供參考，最終以貨代為準'),
                    ])
                    ->action(fn (Product $record, HasTable $livewire, array $data) => app(CountryRuleService::class)->save($record->id, self::country($livewire), $data, DistributorScope::user())),
                Action::make('resetHsCode')->label('還原預設')->color('danger')->icon(Heroicon::OutlinedArrowUturnLeft)
                    ->visible(fn (Product $record, HasTable $livewire) => self::countryValue($record, $livewire) !== null)
                    ->requiresConfirmation()
                    ->modalHeading(fn (Product $record, HasTable $livewire) => '還原'.self::heading($record, $livewire).'的 HS code')
                    ->modalDescription('這個國家改用 SKU 的預設 HS code。已送出的批次不受影響，變更紀錄會留著。')
                    ->action(fn (Product $record, HasTable $livewire) => app(CountryRuleService::class)->delete(
                        ProductCountryRule::where('product_id', $record->id)->where('country_code', self::country($livewire))->firstOrFail(),
                        DistributorScope::user(),
                    )),
            ]);
    }

    public static function getPages(): array
    {
        return ['index' => ListProductHsCodes::route('/')];
    }

    /** 列表目前選的國家：編輯、還原、紀錄都跟著它 */
    private static function country(HasTable $livewire): string
    {
        return $livewire->getTableFilterState('country')['value'] ?? self::DEFAULT_COUNTRY;
    }

    private static function countryValue(Product $record, HasTable $livewire): ?string
    {
        return $record->countryRules->firstWhere('country_code', self::country($livewire))?->hs_code;
    }

    private static function heading(Product $record, HasTable $livewire): string
    {
        return $record->sku.' 在'.DistributorShop::COUNTRIES[self::country($livewire)];
    }
}
