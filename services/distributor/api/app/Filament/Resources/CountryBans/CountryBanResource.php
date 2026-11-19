<?php

namespace App\Filament\Resources\CountryBans;

use App\Domain\Distribution\CountryBanService;
use App\Filament\Resources\CountryBans\Pages\ManageCountryBans;
use App\Filament\Support\DistributorScope;
use App\Models\CountryIngredientBan;
use App\Models\CountryIngredientBanChange;
use App\Models\DistributorShop;
use App\Models\Ingredient;
use BackedEnum;
use Filament\Actions\DeleteAction;
use Filament\Actions\EditAction;
use Filament\Actions\ViewAction;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Infolists\Components\RepeatableEntry;
use Filament\Infolists\Components\TextEntry;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

/** 國家禁令：有列就是禁令，刪除就是解除。下單時比對 SKU 的成分，只警告，決定權在業務 */
class CountryBanResource extends Resource
{
    protected static ?string $model = CountryIngredientBan::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedNoSymbol;

    protected static ?string $modelLabel = '國家禁令';

    protected static ?int $navigationSort = 6;

    protected static ?string $slug = 'country-bans';

    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()->with('ingredient');
    }

    public static function form(Schema $schema): Schema
    {
        return $schema->columns(2)->components([
            Select::make('country_code')->label('國家')->options(DistributorShop::COUNTRIES)->required()->disabledOn('edit'),
            Select::make('ingredient_id')->label('禁止的成分')->options(fn () => Ingredient::orderBy('name')->pluck('name', 'id')->all())->searchable()->required()->disabledOn('edit'),
            TextInput::make('reason')->label('原因')->maxLength(255)->columnSpanFull(),
        ]);
    }

    public static function infolist(Schema $schema): Schema
    {
        return $schema->columns(1)->components([
            RepeatableEntry::make('history')->label('變更紀錄')->columns(4)
                ->state(fn (CountryIngredientBan $record) => $record->changes()->with('changedBy')->latest('id')->get()->map(fn (CountryIngredientBanChange $c) => [
                    'who' => $c->changedBy->name,
                    'when' => $c->created_at->timezone('Asia/Taipei')->format('Y-m-d H:i'),
                    'before' => $c->before ? ($c->before['reason'] ?? '（沒有原因）') : '（新增）',
                    'after' => $c->after ? ($c->after['reason'] ?? '（沒有原因）') : '（解除）',
                ])->all())
                ->schema([
                    TextEntry::make('who')->label('誰'),
                    TextEntry::make('when')->label('何時'),
                    TextEntry::make('before')->label('改前原因'),
                    TextEntry::make('after')->label('改後原因'),
                ]),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('country_code')->label('國家')->formatStateUsing(fn (string $state) => DistributorShop::COUNTRIES[$state] ?? $state),
                TextColumn::make('ingredient.name')->label('禁止的成分')->searchable(),
                TextColumn::make('reason')->label('原因')->placeholder('—'),
            ])
            ->filters([
                SelectFilter::make('country_code')->label('國家')->options(DistributorShop::COUNTRIES),
            ])
            ->recordActions([
                ViewAction::make(),
                EditAction::make()
                    ->using(fn (CountryIngredientBan $record, array $data) => app(CountryBanService::class)->save($record->country_code, $record->ingredient_id, $data['reason'] ?? null, DistributorScope::user())),
                DeleteAction::make()->label('解除')
                    ->modalDescription('解除後下單不再比對這個成分。已送出的批次不受影響，變更紀錄會留著。')
                    ->using(fn (CountryIngredientBan $record) => app(CountryBanService::class)->delete($record, DistributorScope::user())),
            ]);
    }

    public static function getPages(): array
    {
        return ['index' => ManageCountryBans::route('/')];
    }
}
