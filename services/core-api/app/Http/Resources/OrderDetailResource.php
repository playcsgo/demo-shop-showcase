<?php

namespace App\Http\Resources;

use App\Enums\FulfillmentType;
use App\Models\Order;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * 訂單詳情：交付進度用「卡片清單」（§6.5）
 *  - shipment：包裹（物流商、追蹤碼、軌跡）
 *  - warehouse：寄倉入帳（數量）
 *  - booking：服務預約（只有服務種類、預約時段、訂單編號；沒有物流資訊）
 *
 * @mixin Order
 */
class OrderDetailResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        $cards = [];

        foreach ($this->shipments as $s) {
            $cards[] = [
                'type' => 'shipment',
                'title' => "包裹 {$s->seq}",
                'carrier' => $s->carrier,
                'tracking_no' => $s->tracking_no,
                'status' => $s->status,
                'done' => $s->status === 'DELIVERED',
                'items' => $s->items->map(fn ($i) => ['name' => $i->variant->name, 'qty' => $i->qty])->all(),
                'events' => $s->events->map(fn ($e) => ['status' => $e->status, 'at' => $e->occurred_at->toIso8601String()])->all(),
            ];
        }

        foreach ($this->items as $item) {
            if ($item->fulfillment_type === FulfillmentType::Warehouse) {
                $cards[] = [
                    'type' => 'warehouse', 'title' => '寄倉', 'status' => $item->fulfillment_status->value,
                    'done' => in_array($item->fulfillment_status->value, ['DONE', 'REFUNDED'], true),
                    'items' => [['name' => $item->product_name, 'qty' => $item->qty]],
                ];
            }
            if ($item->fulfillment_type === FulfillmentType::Booking && $item->booking) {
                $cards[] = [
                    'type' => 'booking', 'title' => '服務：'.self::serviceName($item->booking->service_type),
                    'order_no' => $this->order_no,
                    'appointment_at' => $item->booking->appointment_at->timezone('Asia/Taipei')->toIso8601String(),
                    'status' => $item->fulfillment_status->value === 'REFUNDED' ? 'REFUNDED' : $item->booking->status,
                    'done' => in_array($item->booking->status, ['CONFIRMED', 'CANCELLED'], true),
                    'cancel_reason' => $item->booking->failure_reason,
                ];
            }
        }

        return [
            'order_no' => $this->order_no,
            'status' => $this->status->value,
            'subtotal' => $this->subtotal,
            'shipping_fee' => $this->shipping_fee,
            'total' => $this->total,
            'paid_at' => $this->paid_at?->toIso8601String(),
            'progress' => ['done' => collect($cards)->where('done', true)->count(), 'total' => count($cards)],
            'items' => $this->items->map(fn ($i) => [
                'id' => $i->id, 'name' => $i->product_name, 'qty' => $i->qty, 'unit_price' => $i->unit_price,
                'brand' => $i->brand->project_code, 'fulfillment_type' => $i->fulfillment_type->value,
                'fulfillment_status' => $i->fulfillment_status->value, 'refunded_qty' => $i->refunded_qty,
            ])->all(),
            'fulfillments' => $cards,
        ];
    }

    private static function serviceName(string $type): string
    {
        return ['health_check' => '健康檢查'][$type] ?? $type;
    }
}
