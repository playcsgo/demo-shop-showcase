<?php

namespace App\Filament\Resources\SettlementStatements\Schemas;

use Filament\Infolists\Components\RepeatableEntry;
use Filament\Infolists\Components\TextEntry;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;

class SettlementStatementInfolist
{
    public static function configure(Schema $schema): Schema
    {
        $money = fn (string $name, string $label) => TextEntry::make($name)->label($label)->money('TWD', decimalPlaces: 0);

        return $schema->columns(1)->components([
            Section::make('結算單')->columns(5)->schema([
                TextEntry::make('legalEntity.name')->label('供應商'),
                TextEntry::make('period')->label('月份'),
                TextEntry::make('status')->label('狀態')->badge(),
                TextEntry::make('confirmed_at')->label('確認時間')->dateTime()->placeholder('未確認'),
                TextEntry::make('supplier_invoice_no')->label('供應商發票')->placeholder('—'),
                $money('gross', '銷售'),
                $money('refunds', '退款'),
                $money('commission', '抽成'),
                $money('fees', '金流手續費'),
                $money('payable', '應付給供應商'),
            ]),
            Section::make('分錄（只新增、不修改；應付 = 分錄加總）')->schema([
                RepeatableEntry::make('entries')->label('')->columns(5)->schema([
                    TextEntry::make('occurred_at')->label('時間')->dateTime('m/d H:i'),
                    TextEntry::make('brand.project_code')->label('品牌')->badge(),
                    TextEntry::make('type')->label('類型')->badge(),
                    TextEntry::make('amount')->label('金額')->money('TWD', decimalPlaces: 0),
                    TextEntry::make('ref')->label('來源')->state(fn ($record) => "{$record->ref_type} #{$record->ref_id}"),
                ]),
            ]),
        ]);
    }
}
