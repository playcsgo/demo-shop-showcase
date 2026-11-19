<?php

namespace App\Filament\Resources\Ingredients;

use App\Filament\Resources\Ingredients\Pages\ManageIngredients;
use App\Models\Ingredient;
use BackedEnum;
use Filament\Actions\DeleteAction;
use Filament\Actions\EditAction;
use Filament\Forms\Components\TextInput;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;

/** 共用的成分清單。有人用的成分刪不掉，要改字直接改名，SKU 和禁令會跟著變 */
class IngredientResource extends Resource
{
    protected static ?string $model = Ingredient::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedBeaker;

    protected static ?string $modelLabel = '成分';

    protected static ?int $navigationSort = 8;

    protected static ?string $slug = 'ingredients';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('name')->label('成分名稱')->required()->maxLength(50)->unique(ignoreRecord: true),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->defaultSort('name')
            ->columns([
                TextColumn::make('name')->label('成分名稱')->searchable(),
                TextColumn::make('products_count')->label('SKU 數')->counts('products'),
                TextColumn::make('bans_count')->label('禁令數')->counts('bans'),
            ])
            ->recordActions([EditAction::make(), DeleteAction::make()]);
    }

    public static function getPages(): array
    {
        return ['index' => ManageIngredients::route('/')];
    }
}
