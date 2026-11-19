<?php

namespace App\Filament\Resources\DistributorBatches;

use App\Domain\Distribution\Money;
use App\Enums\BatchFollowUp;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderType;
use App\Filament\Resources\DistributorBatches\Pages\ListDistributorBatches;
use App\Filament\Resources\DistributorBatches\Pages\ViewDistributorBatch;
use App\Filament\Resources\DistributorBatches\RelationManagers\OrdersRelationManager;
use App\Filament\Support\DistributorScope;
use App\Models\DistributorBatch;
use BackedEnum;
use Filament\Actions\ViewAction;
use Filament\Infolists\Components\RepeatableEntry;
use Filament\Infolists\Components\TextEntry;
use Filament\Resources\Resource;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

/** 業務的主要頁面：審核、付款、排產，訂單也從這裡進去。只看自己經銷商的批次。動作都在 BatchReview，這裡只負責畫面 */
class DistributorBatchResource extends Resource
{
    public const STATUS_LABELS = [
        'IN_REVIEW' => '審核中', 'REJECTED' => '已退回', 'AWAITING_PAYMENT' => '等待付款', 'AWAITING_START' => '待開始',
        'PROCESSING' => '排產中／處理中', 'COMPLETED' => '已完成', 'CANCELLED' => '已取消',
    ];

    protected static ?string $model = DistributorBatch::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedClipboardDocumentCheck;

    protected static ?string $modelLabel = '經銷商批次';

    protected static ?int $navigationSort = 7;

    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()->with('distributor')
            ->whereHas('distributor', fn (Builder $q) => DistributorScope::distributors($q));
    }

    public static function statusLabel(DistributorBatch $b): string
    {
        $label = $b->status === DistributorBatchStatus::Processing
            ? ($b->order_type === DistributorOrderType::Stock ? '處理中' : '排產中')
            : self::STATUS_LABELS[$b->status->value];

        return $label.($b->isResponseOverdue() ? '（已逾回覆日）' : '').($b->isPaymentOverdue() ? '（已逾付款期限）' : '');
    }

    public static function infolist(Schema $schema): Schema
    {
        return $schema->columns(1)->components([
            Section::make('批次')->columns(3)->schema([
                TextEntry::make('batch_no')->label('批次'),
                TextEntry::make('distributor.name')->label('經銷商'),
                TextEntry::make('order_type')->label('類型')->formatStateUsing(fn ($state) => $state->value === 'stock' ? '現貨' : '早鳥'),
                TextEntry::make('status')->label('狀態')->badge()
                    ->state(fn (DistributorBatch $record) => self::statusLabel($record))
                    ->color(fn (DistributorBatch $record) => $record->isResponseOverdue() || $record->isPaymentOverdue() ? 'danger' : 'gray'),
                TextEntry::make('follow_up')->label('追蹤')->badge()
                    ->state(fn (DistributorBatch $record) => $record->followUp()->label())
                    ->color(fn (DistributorBatch $record) => $record->followUp()->color()),
                TextEntry::make('total')->label('總額')->state(fn (DistributorBatch $record) => Money::format($record->total_minor, $record->currency)),
                TextEntry::make('prepay')->label('預付')->state(fn (DistributorBatch $record) => ($record->prepay_bps / 100).'%：'.Money::format($record->prepay_minor, $record->currency)),
                TextEntry::make('anticipated_response_date')->label('預計回覆日')->date('Y-m-d'),
                TextEntry::make('revision')->label('第幾次送出'),
            ]),
            // 進入履行後審核資料就不是重點，收起來，下面的訂單才看得到
            Section::make('MOQ')->collapsible()->collapsed(fn (DistributorBatch $record) => self::isPastReview($record))->schema([
                RepeatableEntry::make('moqRows')->hiddenLabel()->columns(3)
                    ->state(fn (DistributorBatch $record) => array_map(fn (array $m) => [
                        'sku' => $m['sku'], 'cases' => "{$m['total_cases']} / {$m['moq_cases']} 箱", 'result' => $m['met'] ? '達到' : '未達',
                    ], $record->moq_results))
                    ->schema([
                        TextEntry::make('sku')->label('商品'),
                        TextEntry::make('cases')->label('合計／MOQ'),
                        TextEntry::make('result')->label('結果')->badge()->color(fn (string $state) => $state === '未達' ? 'danger' : 'success'),
                    ]),
            ]),
            Section::make('國家禁令與資料提醒')->description('只是提醒，通過或退回由業務決定')->collapsible()->collapsed(fn (DistributorBatch $record) => self::isPastReview($record))->schema([
                TextEntry::make('warningLines')->hiddenLabel()->listWithLineBreaks()->placeholder('沒有警告')
                    ->state(fn (DistributorBatch $record) => array_map(fn (array $w) => "{$w['shop_name']}．{$w['sku']}：".implode('、', array_filter([
                        ...array_map(fn (array $b) => "含{$b['name']}，這個國家禁止".($b['reason'] ? "（{$b['reason']}）" : ''), $w['banned_ingredients']),
                        $w['missing_ingredients'] ? '未填成分，無法檢查' : null,
                        $w['missing_hs_code'] ? '缺 HS code' : null,
                    ])), $record->warnings)),
            ]),
        ]);
    }

    private static function isPastReview(DistributorBatch $batch): bool
    {
        return in_array($batch->status, [DistributorBatchStatus::Processing, DistributorBatchStatus::Completed], true);
    }

    public static function getRelations(): array
    {
        return [OrdersRelationManager::class];
    }

    public static function table(Table $table): Table
    {
        return $table
            ->defaultSort('id', 'desc')
            ->columns([
                TextColumn::make('batch_no')->label('批次')->searchable(),
                TextColumn::make('distributor.name')->label('經銷商'),
                TextColumn::make('follow_up')->label('追蹤')->badge()
                    ->state(fn (DistributorBatch $record) => $record->followUp()->label())
                    ->color(fn (DistributorBatch $record) => $record->followUp()->color()),
                TextColumn::make('order_type')->label('類型')->formatStateUsing(fn ($state) => $state->value === 'stock' ? '現貨' : '早鳥'),
                TextColumn::make('status')->label('狀態')->badge()
                    ->state(fn (DistributorBatch $record) => self::statusLabel($record))
                    ->color(fn (DistributorBatch $record) => $record->isResponseOverdue() || $record->isPaymentOverdue() ? 'danger' : ($record->status === DistributorBatchStatus::InReview ? 'warning' : 'gray')),
                TextColumn::make('total_minor')->label('總額')->formatStateUsing(fn (int $state, DistributorBatch $record) => Money::format($state, $record->currency)),
                TextColumn::make('anticipated_response_date')->label('預計回覆日')->date('Y-m-d')->toggleable(isToggledHiddenByDefault: true),
            ])
            ->filters([
                SelectFilter::make('follow_up')->label('追蹤')
                    ->options(collect(BatchFollowUp::cases())->mapWithKeys(fn (BatchFollowUp $f) => [$f->value => $f->label()])->all())
                    ->query(fn (Builder $query, array $data) => match (BatchFollowUp::tryFrom($data['value'] ?? '')) {
                        BatchFollowUp::NeedsAction => $query->whereIn('id', DistributorBatch::needsAction()->select('id')),
                        BatchFollowUp::Ended => $query->whereIn('status', [DistributorBatchStatus::Completed, DistributorBatchStatus::Cancelled]),
                        BatchFollowUp::Waiting => $query->whereNotIn('status', [DistributorBatchStatus::Completed, DistributorBatchStatus::Cancelled])->whereNotIn('id', DistributorBatch::needsAction()->select('id')),
                        null => $query,
                    }),
                SelectFilter::make('status')->label('狀態')->options(self::STATUS_LABELS),
            ])
            ->recordActions([ViewAction::make()]);
    }

    public static function getPages(): array
    {
        return [
            'index' => ListDistributorBatches::route('/'),
            'view' => ViewDistributorBatch::route('/{record}'),
        ];
    }
}
