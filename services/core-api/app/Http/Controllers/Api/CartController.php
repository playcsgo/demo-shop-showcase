<?php

namespace App\Http\Controllers\Api;

use App\Domain\Cart\CartService;
use App\Enums\FulfillmentType;
use App\Http\Controllers\Controller;
use App\Http\Resources\CartResource;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Validation\Rule;

class CartController extends Controller
{
    public function __construct(private CartService $carts) {}

    public function show(Request $request): CartResource
    {
        return new CartResource($this->carts->cartOf($request->user()));
    }

    public function putItem(Request $request): CartResource
    {
        $data = $request->validate([
            'variant_id' => 'required|integer|exists:product_variants,id',
            'fulfillment_type' => ['required', Rule::enum(FulfillmentType::class)],
            'qty' => 'required|integer|min:1|max:99',
            'appointment_at' => 'nullable|date',
        ]);

        return new CartResource($this->carts->putItem(
            $request->user(), $data['variant_id'], FulfillmentType::from($data['fulfillment_type']), $data['qty'],
            isset($data['appointment_at']) ? Carbon::parse($data['appointment_at'])->utc() : null, // 資料庫一律存 UTC
        ));
    }

    public function removeItem(Request $request, int $itemId): CartResource
    {
        return new CartResource($this->carts->removeItem($request->user(), $itemId));
    }
}
