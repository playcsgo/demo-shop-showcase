<?php

namespace App\Filament\Resources\Orders\Pages;

use App\Domain\DomainException;
use App\Domain\Refunds\RefundService;
use App\Filament\Resources\Orders\OrderResource;
use App\Filament\Resources\Orders\Schemas\OrderInfolist;
use App\Models\Order;
use Filament\Actions\Action;
use Filament\Forms\Components\Checkbox;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\ViewRecord;
use Filament\Schemas\Components\Utilities\Get;
use Illuminate\Support\Str;

class ViewOrder extends ViewRecord
{
    protected static string $resource = OrderResource::class;

    protected function getHeaderActions(): array
    {
        return [
            // 部分退款：只能退「自己品牌」而且「還有可退數量」的明細；送出後走 outbox → hub → 金流（非同步）
            Action::make('refund')
                ->label('部分退款')
                ->color('warning')
                ->visible(fn (Order $record) => auth()->user()->can('refund', $record) && $record->payment?->status === 'SUCCEEDED')
                ->schema([
                    Select::make('order_item_id')->label('明細')->required()
                        ->options(fn (Order $record) => OrderInfolist::visibleItems($record)
                            ->filter(fn ($i) => $i->refundableQty() > 0)
                            ->mapWithKeys(fn ($i) => [$i->id => "{$i->product_name}（可退 {$i->refundableQty()}）"])->all()),
                    TextInput::make('qty')->label('數量')->numeric()->minValue(1)->default(1)->required(),
                    // 超過送達後 7 天的退款期限（AIC-016）：要勾例外並寫原因，誰按的會記下來
                    Checkbox::make('override')->label('超過期限仍要退')->live(),
                    TextInput::make('override_reason')->label('原因')->maxLength(200)
                        ->visible(fn (Get $get) => (bool) $get('override'))->required(fn (Get $get) => (bool) $get('override')),
                ])
                ->action(function (Order $record, array $data) {
                    // 伺服器端再檢查一次範圍（不只靠下拉選單）：品牌經理不能退別的品牌的明細
                    abort_unless(OrderInfolist::visibleItems($record)->contains('id', (int) $data['order_item_id']), 403);
                    try {
                        $refund = app(RefundService::class)->request($record, [(int) $data['order_item_id'] => (int) $data['qty']],
                            'admin:'.auth()->id(), 'admin-'.Str::uuid(), requestedBy: 'admin:'.auth()->id(),
                            overrideReason: ! empty($data['override']) ? trim((string) $data['override_reason']) : null);
                        Notification::make()->success()->title("已送出退款 NT\$ {$refund->amount}")->body('金流確認後會自動更新狀態')->send();
                    } catch (DomainException $e) {
                        Notification::make()->danger()->title('無法退款')->body($e->getMessage())->send();
                    }
                }),
        ];
    }
}
