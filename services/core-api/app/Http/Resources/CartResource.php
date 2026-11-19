<?php

namespace App\Http\Resources;

use App\Models\Cart;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin Cart */
class CartResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        $items = $this->items->map(fn ($i) => [
            'id' => $i->id,
            'variant_id' => $i->variant_id,
            'name' => $i->variant->name,
            'brand' => $i->variant->product->brand->project_code,
            'unit_price' => $i->variant->price,
            'qty' => $i->qty,
            'fulfillment_type' => $i->fulfillment_type->value,
            'appointment_at' => $i->appointment_at?->toIso8601String(),
            'hold_expires_at' => $i->hold_expires_at?->toIso8601String(), // 醫院的時段保留到何時（前台倒數）
        ]);

        return ['items' => $items->all(), 'subtotal' => $items->sum(fn ($i) => $i['unit_price'] * $i['qty'])];
    }
}
