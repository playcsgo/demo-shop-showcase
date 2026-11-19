<?php

namespace App\Filament\Resources\SettlementStatements\Pages;

use App\Domain\Settlement\StatementGenerator;
use App\Filament\Resources\SettlementStatements\SettlementStatementResource;
use App\Models\SettlementStatement;
use Filament\Actions\Action;
use Filament\Forms\Components\TextInput;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\ViewRecord;

class ViewSettlementStatement extends ViewRecord
{
    protected static string $resource = SettlementStatementResource::class;

    protected function getHeaderActions(): array
    {
        return [
            // 確認後就鎖定：之後的退款會進下個月，不改這張
            Action::make('confirm')
                ->label('確認結算單')
                ->requiresConfirmation()
                ->modalDescription('確認後這張結算單就不能再變動；之後發生的退款會列入下個月。')
                ->visible(fn (SettlementStatement $record) => $record->status === 'DRAFT' && auth()->user()->can('manage', SettlementStatement::class))
                ->schema([TextInput::make('supplier_invoice_no')->label('供應商發票號碼')->maxLength(20)])
                ->action(function (SettlementStatement $record, array $data) {
                    app(StatementGenerator::class)->confirm($record, auth()->id(), $data['supplier_invoice_no'] ?? null);
                    Notification::make()->success()->title('已確認')->send();
                    $this->refreshFormData(['status']);
                }),
        ];
    }
}
