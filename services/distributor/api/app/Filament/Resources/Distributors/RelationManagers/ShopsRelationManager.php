<?php

namespace App\Filament\Resources\Distributors\RelationManagers;

use App\Domain\Distribution\ShopCatalog;
use App\Domain\Distribution\ShopItemSettings;
use App\Domain\DomainException;
use App\Filament\Support\DistributorScope;
use App\Models\DistributorShop;
use Filament\Actions\Action;
use Filament\Actions\CreateAction;
use Filament\Actions\EditAction;
use Filament\Forms\Components\CheckboxList;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Notifications\Notification;
use Filament\Resources\RelationManagers\RelationManager;
use Filament\Schemas\Schema;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Model;

/** 經銷商的收貨地點：只有業務能新增，經銷商沒有這個 API */
class ShopsRelationManager extends RelationManager
{
    protected static string $relationship = 'shops';

    protected static ?string $title = 'Shop';

    protected static ?string $modelLabel = 'Shop';

    public static function canViewForRecord(Model $ownerRecord, string $pageClass): bool
    {
        return (bool) auth()->user()?->can('update', $ownerRecord);
    }

    public function form(Schema $schema): Schema
    {
        return $schema->columns(2)->components([
            TextInput::make('name')->label('名稱')->required()->maxLength(255),
            Select::make('country_code')->label('國家')->options(DistributorShop::COUNTRIES)->required(),
            TextInput::make('city')->label('城市')->required()->maxLength(255),
            TextInput::make('address')->label('地址')->required()->maxLength(255),
            TextInput::make('destination_port')->label('目的港')->maxLength(100),
        ]);
    }

    public function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')->label('名稱'),
                TextColumn::make('country_code')->label('國家')->formatStateUsing(fn (string $state) => DistributorShop::COUNTRIES[$state] ?? $state),
                TextColumn::make('city')->label('城市'),
                TextColumn::make('address')->label('地址'),
                TextColumn::make('destination_port')->label('目的港'),
            ])
            ->headerActions([CreateAction::make()])
            ->recordActions([
                EditAction::make(),
                Action::make('displayItems')->label('顯示商品')
                    ->fillForm(fn (DistributorShop $record) => ['product_ids' => $record->items()->pluck('product_id')->all()])
                    ->schema(fn (DistributorShop $record) => $this->displayItemFields($record))
                    ->action(function (DistributorShop $record, array $data) {
                        try {
                            app(ShopItemSettings::class)->replace($record, $data['product_ids'] ?? [], DistributorScope::user());
                            Notification::make()->success()->title('已存檔')->send();
                        } catch (DomainException $e) {
                            Notification::make()->danger()->title('無法存檔')->body($e->getMessage())->send();
                        }
                    }),
            ]);
    }

    /**
     * 只列合約允許的商品
     *
     * @return array<int, mixed>
     */
    private function displayItemFields(DistributorShop $shop): array
    {
        $allowed = collect(app(ShopCatalog::class)->allowed($shop));

        return [
            CheckboxList::make('product_ids')->label('要顯示的商品')->columns(2)
                ->options($allowed->mapWithKeys(fn (array $item) => [$item['product_id'] => "{$item['sku']} {$item['name']}"])->all()),
        ];
    }
}
