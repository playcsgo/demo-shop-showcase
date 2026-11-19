<?php

namespace App\Filament\Resources\ContractTemplates;

use App\Domain\Distribution\Money;
use App\Filament\Resources\ContractTemplates\Pages\CreateContractTemplate;
use App\Filament\Resources\ContractTemplates\Pages\EditContractTemplate;
use App\Filament\Resources\ContractTemplates\Pages\ListContractTemplates;
use App\Filament\Support\ContractTermsForm;
use App\Models\ContractTemplate;
use BackedEnum;
use Filament\Actions\EditAction;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

/** 業務自己的合約範本：只列自己的 */
class ContractTemplateResource extends Resource
{
    protected static ?string $model = ContractTemplate::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedDocumentDuplicate;

    protected static ?string $modelLabel = '合約範本';

    protected static ?int $navigationSort = 5;

    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()->where('owner_user_id', auth()->id());
    }

    public static function form(Schema $schema): Schema
    {
        return $schema->columns(2)->components([
            TextInput::make('name')->label('範本名稱')->required()->maxLength(255),
            Select::make('currency')->label('幣別')->options(Money::options())->required(),
            ...ContractTermsForm::fields(),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')->label('範本名稱')->searchable(),
                TextColumn::make('currency')->label('幣別'),
                TextColumn::make('incoterm')->label('Incoterm')->badge(),
                TextColumn::make('items_count')->label('品項')->counts('items'),
            ])
            ->recordActions([EditAction::make()]);
    }

    public static function getPages(): array
    {
        return [
            'index' => ListContractTemplates::route('/'),
            'create' => CreateContractTemplate::route('/create'),
            'edit' => EditContractTemplate::route('/{record}/edit'),
        ];
    }
}
