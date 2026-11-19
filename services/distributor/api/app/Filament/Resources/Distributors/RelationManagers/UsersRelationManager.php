<?php

namespace App\Filament\Resources\Distributors\RelationManagers;

use App\Enums\DistributorUserRole;
use Filament\Actions\CreateAction;
use Filament\Actions\EditAction;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Resources\RelationManagers\RelationManager;
use Filament\Schemas\Schema;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Model;

/** 經銷商的帳號：業務建立，並設定和重設密碼（這階段不做忘記密碼） */
class UsersRelationManager extends RelationManager
{
    protected static string $relationship = 'users';

    protected static ?string $title = '帳號';

    protected static ?string $modelLabel = '帳號';

    /** 權限跟著經銷商走：能改這家經銷商，才能管它的帳號 */
    public static function canViewForRecord(Model $ownerRecord, string $pageClass): bool
    {
        return (bool) auth()->user()?->can('update', $ownerRecord);
    }

    public function form(Schema $schema): Schema
    {
        return $schema->columns(2)->components([
            TextInput::make('name')->label('姓名')->required()->maxLength(255),
            TextInput::make('email')->label('Email')->email()->required()->maxLength(255)->unique(ignoreRecord: true),
            Select::make('role')->label('角色')->required()->default(DistributorUserRole::Buyer->value)
                ->options(['manager' => 'manager（設定 shop、下單）', 'buyer' => 'buyer（下單）']),
            // 編輯時留空＝不改密碼
            TextInput::make('password')->label('密碼')->password()->revealable()->maxLength(200)
                ->required(fn (string $operation) => $operation === 'create')
                ->dehydrated(fn (?string $state) => filled($state)),
        ]);
    }

    public function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')->label('姓名'),
                TextColumn::make('email')->label('Email'),
                TextColumn::make('role')->label('角色')->badge(),
            ])
            ->headerActions([CreateAction::make()])
            ->recordActions([EditAction::make()]);
    }
}
