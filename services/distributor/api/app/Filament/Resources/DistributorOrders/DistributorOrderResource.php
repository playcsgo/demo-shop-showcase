<?php

namespace App\Filament\Resources\DistributorOrders;

use App\Domain\Distribution\Money;
use App\Domain\Distribution\OrderFulfilment;
use App\Domain\DomainException;
use App\Enums\DistributorOrderStatus;
use App\Enums\DistributorOrderType;
use App\Filament\Resources\DistributorOrders\Pages\ViewDistributorOrder;
use App\Filament\Support\DistributorScope;
use App\Models\DistributorOrder;
use App\Models\DistributorOrderEtaChange;
use App\Models\DistributorOrderItem;
use BackedEnum;
use Filament\Actions\Action;
use Filament\Forms\Components\DatePicker;
use Filament\Infolists\Components\RepeatableEntry;
use Filament\Infolists\Components\TextEntry;
use Filament\Notifications\Notification;
use Filament\Resources\Resource;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;
use Filament\Support\Colors\Color;
use Filament\Support\Icons\Heroicon;
use Illuminate\Database\Eloquent\Builder;

/** 訂單只有明細頁，從批次點進來，所以側邊欄不列。按鈕依 DistributorOrderPolicy 顯示；規則在 OrderFulfilment */
class DistributorOrderResource extends Resource
{
    protected static ?string $model = DistributorOrder::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedTruck;

    protected static ?string $modelLabel = '經銷商訂單';

    protected static ?string $recordRouteKeyName = 'order_no';

    public static function shouldRegisterNavigation(): bool
    {
        return false;
    }

    public static function statusLabel(DistributorOrder $order): string
    {
        return match ($order->status) {
            DistributorOrderStatus::Pending => '未開始',
            DistributorOrderStatus::InProgress => $order->batch->order_type === DistributorOrderType::Stock ? '待出貨' : '排產中',
            DistributorOrderStatus::Shipped => '已出貨',
            DistributorOrderStatus::Delivered => '已送達',
        };
    }

    public static function getRecordRouteBindingEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()->with('shop.distributor', 'batch', 'items.product');
    }

    public static function infolist(Schema $schema): Schema
    {
        return $schema->columns(1)->components([
            Section::make('訂單')->columns(3)->schema([
                TextEntry::make('order_no')->label('單號'),
                TextEntry::make('shop.distributor.name')->label('經銷商'),
                TextEntry::make('shop.name')->label('Shop'),
                TextEntry::make('status')->label('狀態')->badge()->formatStateUsing(fn ($state, DistributorOrder $record) => self::statusLabel($record)),
                TextEntry::make('requested_ship_date')->label('交期')->date('Y-m-d')->placeholder('現貨'),
                TextEntry::make('eta_date')->label('ETA（預計抵達客戶）')->date('Y-m-d')->placeholder('未填'),
                TextEntry::make('subtotal')->label('金額')->state(fn (DistributorOrder $record) => Money::format($record->subtotal_minor, $record->batch->currency)),
            ]),
            Section::make('明細')->description('HS code 只供參考，最終以貨代為準')->schema([
                RepeatableEntry::make('itemRows')->hiddenLabel()->columns(6)
                    ->state(fn (DistributorOrder $record) => $record->items->map(fn (DistributorOrderItem $i) => [
                        'sku' => $i->product->sku,
                        'name' => $i->product->name,
                        'qty' => "{$i->qty_cases} 箱（{$i->qty_units} 件）",
                        'hs_code' => $i->hs_code,
                        'unit_price' => Money::format($i->unit_price_minor, $record->batch->currency).' / 箱',
                        'amount' => Money::format($i->amount_minor, $record->batch->currency),
                    ])->all())
                    ->schema([
                        TextEntry::make('sku')->label('SKU'),
                        TextEntry::make('name')->label('商品'),
                        TextEntry::make('qty')->label('數量'),
                        TextEntry::make('hs_code')->label('HS code')->placeholder('缺'),
                        TextEntry::make('unit_price')->label('單價'),
                        TextEntry::make('amount')->label('金額'),
                    ]),
            ]),
            Section::make('ETA 修改紀錄')->description('內部用，經銷商只看得到最新的日期')->collapsible()->collapsed()->schema([
                RepeatableEntry::make('etaHistory')->hiddenLabel()->columns(4)->placeholder('還沒有改過')
                    ->state(fn (DistributorOrder $record) => $record->etaChanges()->with('changedBy')->latest('id')->get()->map(fn (DistributorOrderEtaChange $c) => [
                        'who' => $c->changedBy->name,
                        'when' => $c->created_at->timezone('Asia/Taipei')->format('Y-m-d H:i'),
                        'before' => $c->before_date?->toDateString() ?? '（沒有）',
                        'after' => $c->after_date?->toDateString() ?? '（清空）',
                    ])->all())
                    ->schema([
                        TextEntry::make('who')->label('誰'),
                        TextEntry::make('when')->label('何時'),
                        TextEntry::make('before')->label('改前'),
                        TextEntry::make('after')->label('改後'),
                    ]),
            ]),
        ]);
    }

    /** @return array<int, Action> 批次頁和明細頁共用 */
    public static function fulfilmentActions(): array
    {
        // 重新載入：這些動作可能讓整批變已完成，批次頁和訂單列要一起更新
        $attempt = function ($livewire, callable $work, string $success) {
            try {
                $work(app(OrderFulfilment::class), DistributorScope::user());
                Notification::make()->success()->title($success)->send();
            } catch (DomainException $e) {
                Notification::make()->danger()->title('無法完成')->body($e->getMessage())->send();
            }
            $livewire->js('window.location.reload()');
        };
        $can = fn (DistributorOrder $record, DistributorOrderStatus ...$statuses) => in_array($record->status, $statuses, true) && DistributorScope::user()->can('fulfil', $record);

        return [
            Action::make('setEta')->label(fn (DistributorOrder $record) => $record->eta_date ? '改 ETA' : '填 ETA')->color('gray')
                ->modalHeading('ETA（預計抵達客戶的日期）')
                ->visible(fn (DistributorOrder $record) => $can($record, DistributorOrderStatus::InProgress, DistributorOrderStatus::Shipped))
                ->fillForm(fn (DistributorOrder $record) => ['eta_date' => $record->eta_date?->toDateString()])
                ->schema([DatePicker::make('eta_date')->label('ETA')->native(false)->displayFormat('Y-m-d')->helperText('選填，可以一直改；經銷商看得到最新的日期')])
                ->action(fn (DistributorOrder $record, array $data, $livewire) => $attempt($livewire, fn (OrderFulfilment $f, $by) => $f->setEta($record, $data['eta_date'] ?? null, $by), '已更新 ETA')),
            Action::make('ship')->label('確認出貨')->color('success')->requiresConfirmation()
                ->modalDescription('現貨單會在這時扣庫存。')
                ->visible(fn (DistributorOrder $record) => $can($record, DistributorOrderStatus::InProgress))
                ->action(fn (DistributorOrder $record, $livewire) => $attempt($livewire, fn (OrderFulfilment $f, $by) => $f->ship($record, $by), '已出貨')),
            Action::make('deliver')->label('確認送達')->color(Color::Orange)   // 和綠色的確認出貨分開，避免按錯->requiresConfirmation()
                ->modalDescription('確認客戶已收到貨。送達後不能再改 ETA。')
                ->visible(fn (DistributorOrder $record) => $can($record, DistributorOrderStatus::Shipped))
                ->action(fn (DistributorOrder $record, $livewire) => $attempt($livewire, fn (OrderFulfilment $f, $by) => $f->deliver($record, $by), '已送達')),
        ];
    }

    public static function getPages(): array
    {
        return [
            'view' => ViewDistributorOrder::route('/{record}'),
        ];
    }
}
