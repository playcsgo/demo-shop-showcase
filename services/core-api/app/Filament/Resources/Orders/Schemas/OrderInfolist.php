<?php

namespace App\Filament\Resources\Orders\Schemas;

use App\Filament\Resources\Orders\Tables\OrdersTable;
use App\Filament\Support\BrandScope;
use App\Models\Order;
use Filament\Infolists\Components\RepeatableEntry;
use Filament\Infolists\Components\TextEntry;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;

class OrderInfolist
{
    /** 混合訂單：品牌經理只看得到自己品牌的明細 */
    public static function visibleItems(Order $order)
    {
        $scope = BrandScope::user()->brandScope();

        return $order->items->filter(fn ($i) => $scope === null || in_array($i->brand_id, $scope, true))->values();
    }

    public static function isScoped(): bool
    {
        return BrandScope::user()->brandScope() !== null;
    }

    /** 只顯示「裝了自己品牌商品」的包裹 */
    public static function visibleShipments(Order $order)
    {
        $itemIds = self::visibleItems($order)->pluck('id');

        return $order->shipments->filter(fn ($s) => $s->items->pluck('order_item_id')->intersect($itemIds)->isNotEmpty())->values();
    }

    /** 只顯示「退到自己品牌商品」的退款（金額只算自己的部分） */
    public static function visibleRefunds(Order $order)
    {
        $itemIds = self::visibleItems($order)->pluck('id');

        return $order->refunds->load('items')->map(function ($r) use ($itemIds) {
            $mine = $r->items->whereIn('order_item_id', $itemIds);
            if ($mine->isEmpty()) {
                return null;
            }

            return (object) ['amount' => $mine->sum('amount'), 'reason' => $r->reason, 'status' => $r->status, 'created_at' => $r->created_at];
        })->filter()->values();
    }

    public static function configure(Schema $schema): Schema
    {
        return $schema->columns(1)->components([
            Section::make('訂單')->columns(4)->schema([
                TextEntry::make('order_no')->label('訂單編號')->copyable(),
                TextEntry::make('status')->label('狀態')->badge()->color(fn ($state) => OrdersTable::statusColor($state)),
                TextEntry::make('customer.name')->label('顧客'),
                TextEntry::make('paid_at')->label('付款時間')->dateTime()->placeholder('未付款'),
                // 整張訂單的金額含其他品牌 → 範圍受限的人只看自己品牌的小計
                TextEntry::make('subtotal')->label('小計')->money('TWD', decimalPlaces: 0)->hidden(fn () => self::isScoped()),
                TextEntry::make('shipping_fee')->label('運費')->money('TWD', decimalPlaces: 0)->hidden(fn () => self::isScoped()),
                TextEntry::make('total')->label('總額')->money('TWD', decimalPlaces: 0)->hidden(fn () => self::isScoped()),
                TextEntry::make('payment.refunded_amount')->label('已退款')->money('TWD', decimalPlaces: 0)->hidden(fn () => self::isScoped()),
                TextEntry::make('my_subtotal')->label('我的品牌小計')->money('TWD', decimalPlaces: 0)->visible(fn () => self::isScoped())
                    ->state(fn (Order $record) => self::visibleItems($record)->sum('line_total')),
            ]),
            Section::make('明細')->schema([
                RepeatableEntry::make('visible_items')->label('')->columns(7)
                    ->state(fn (Order $record) => self::visibleItems($record))
                    ->schema([
                        TextEntry::make('brand.project_code')->label('品牌')->badge(),
                        TextEntry::make('product_name')->label('商品'),
                        TextEntry::make('qty')->label('數量'),
                        TextEntry::make('line_total')->label('金額')->money('TWD', decimalPlaces: 0),
                        TextEntry::make('fulfillment_type')->label('交付方式')->badge(),
                        TextEntry::make('fulfillment_status')->label('交付狀態')->badge(),
                        TextEntry::make('refunded_qty')->label('已退數量'),
                    ]),
            ]),
            Section::make('包裹')->visible(fn (Order $record) => self::visibleShipments($record)->isNotEmpty())->schema([
                RepeatableEntry::make('visible_shipments')->label('')->columns(5)
                    ->state(fn (Order $record) => self::visibleShipments($record))
                    ->schema([
                        TextEntry::make('seq')->label('包裹')->formatStateUsing(fn ($state) => "包裹 {$state}"),
                        TextEntry::make('carrier')->label('物流'),
                        TextEntry::make('tracking_no')->label('追蹤碼')->placeholder('—'),
                        TextEntry::make('status')->label('狀態')->badge(),
                        TextEntry::make('timeline')->label('軌跡')
                            ->state(fn ($record) => $record->events->pluck('status')->join(' → ') ?: '—'),
                    ]),
            ]),
            Section::make('退款')->visible(fn (Order $record) => self::visibleRefunds($record)->isNotEmpty())->schema([
                RepeatableEntry::make('visible_refunds')->label('')->columns(4)
                    ->state(fn (Order $record) => self::visibleRefunds($record))
                    ->schema([
                        TextEntry::make('amount')->label('金額')->money('TWD', decimalPlaces: 0),
                        TextEntry::make('reason')->label('原因'),
                        TextEntry::make('status')->label('狀態')->badge(),
                        TextEntry::make('created_at')->label('時間')->dateTime(),
                    ]),
            ]),
        ]);
    }
}
