<?php

namespace App\Filament\Resources\Distributors;

use App\Domain\Distribution\Money;
use App\Enums\ContractStatus;
use App\Enums\DistributorStatus;
use App\Filament\Resources\Distributors\Pages\CreateDistributor;
use App\Filament\Resources\Distributors\Pages\EditDistributor;
use App\Filament\Resources\Distributors\Pages\ListDistributors;
use App\Filament\Resources\Distributors\RelationManagers\ContractsRelationManager;
use App\Filament\Resources\Distributors\RelationManagers\ShopsRelationManager;
use App\Filament\Resources\Distributors\RelationManagers\UsersRelationManager;
use App\Filament\Support\DistributorScope;
use App\Models\Distributor;
use App\Models\User;
use BackedEnum;
use Filament\Actions\DeleteAction;
use Filament\Actions\EditAction;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

/** 經銷商：業務開通的第一步。帳號和 shop 用 Relation Manager，掛在經銷商底下 */
class DistributorResource extends Resource
{
    protected static ?string $model = Distributor::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedBuildingStorefront;

    protected static ?string $modelLabel = '經銷商';

    protected static ?int $navigationSort = 4;

    public static function getEloquentQuery(): Builder
    {
        return DistributorScope::distributors(parent::getEloquentQuery()->with('sales'));
    }

    public static function form(Schema $schema): Schema
    {
        return $schema->columns(2)->components([
            TextInput::make('code')->label('代碼')->required()->maxLength(20)->unique(ignoreRecord: true)
                ->disabledOn('edit')->helperText('建立後不能修改'),
            TextInput::make('name')->label('名稱')->required()->maxLength(255),
            // 合約生效過就不能改：歷史金額是用這個幣別談的。只有草稿時還能改，草稿價格要重填
            Select::make('currency')->label('幣別')->options(Money::options())->required()
                ->disabled(fn (?Distributor $record) => $record?->contracts()->where('status', '!=', ContractStatus::Draft)->exists() ?? false)
                ->helperText(fn (?Distributor $record) => $record?->contracts()->where('status', ContractStatus::Draft)->exists() ? '改幣別後，草稿合約的價格要重填' : null),
            Select::make('status')->label('狀態')->options(['active' => '合作中', 'suspended' => '停權'])->default(DistributorStatus::Active->value)->required(),
            // 業務看不到這欄：建立時固定掛在自己名下（hidden 的欄位不會送出，改不到別人）
            Select::make('sales_user_id')->label('負責業務')->required()
                ->options(fn () => User::role('sales')->pluck('name', 'id')->all())
                ->visible(fn () => DistributorScope::user()->hasRole('super_admin')),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('code')->label('代碼')->searchable(),
                TextColumn::make('name')->label('名稱')->searchable(),
                TextColumn::make('currency')->label('幣別'),
                TextColumn::make('sales.name')->label('負責業務'),
                TextColumn::make('status')->label('狀態')->badge()
                    ->formatStateUsing(fn (DistributorStatus $state) => $state === DistributorStatus::Active ? '合作中' : '停權')
                    ->color(fn (DistributorStatus $state) => $state === DistributorStatus::Active ? 'success' : 'gray'),
            ])
            ->recordActions([EditAction::make(), self::deleteAction()]);
    }

    /** 有訂單就拒絕，金流和出貨紀錄不能消失；資料庫的 RESTRICT 外鍵是最後防線 */
    public static function deleteAction(): DeleteAction
    {
        return DeleteAction::make()
            ->modalDescription('會連帶刪除這家經銷商的帳號、shop、顯示商品和合約，無法復原。已有訂單的經銷商不能刪除，請改成停權。')
            ->failureNotificationTitle('這個經銷商已有訂單，不能刪除，請改成停權')
            ->using(fn (Distributor $record) => ! $record->hasOrders() && $record->delete());
    }

    public static function getRelations(): array
    {
        return [UsersRelationManager::class, ShopsRelationManager::class, ContractsRelationManager::class];
    }

    public static function getPages(): array
    {
        return [
            'index' => ListDistributors::route('/'),
            'create' => CreateDistributor::route('/create'),
            'edit' => EditDistributor::route('/{record}/edit'),
        ];
    }
}
