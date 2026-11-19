<?php

namespace App\Filament\Resources\SettlementStatements\Pages;

use App\Domain\DomainException;
use App\Domain\Settlement\StatementGenerator;
use App\Filament\Resources\SettlementStatements\SettlementStatementResource;
use App\Filament\Resources\SettlementStatements\Widgets\UnsettledTotals;
use App\Models\LegalEntity;
use App\Models\SettlementStatement;
use Filament\Actions\Action;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\ListRecords;

class ListSettlementStatements extends ListRecords
{
    protected static string $resource = SettlementStatementResource::class;

    protected function getHeaderWidgets(): array
    {
        return [UnsettledTotals::class];
    }

    protected function getHeaderActions(): array
    {
        return [
            // 產生（或重新產生草稿）：把「還沒結算、發生在月底前」的分錄掛到這張結算單
            Action::make('generate')
                ->label('產生結算單')
                ->visible(fn () => auth()->user()->can('manage', SettlementStatement::class))
                ->schema([
                    Select::make('legal_entity_id')->label('供應商')->required()
                        ->options(LegalEntity::where('role', 'supplier')->pluck('name', 'id')),
                    TextInput::make('period')->label('月份')->required()->regex('/^\d{4}-\d{2}$/')->default(now()->format('Y-m')),
                ])
                ->action(function (array $data) {
                    try {
                        $s = app(StatementGenerator::class)->generate((int) $data['legal_entity_id'], $data['period']);
                        Notification::make()->success()->title("{$s->period} 應付 NT\$ ".number_format($s->payable))->send();
                    } catch (DomainException $e) {
                        Notification::make()->danger()->title($e->getMessage())->send();
                    }
                }),
        ];
    }
}
