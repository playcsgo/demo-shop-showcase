<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\OrderDetailResource;
use App\Models\Order;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class OrderController extends Controller
{
    /** 顧客只看得到自己的訂單（擁有權在 core 判斷，§8.3） */
    public function index(Request $request): JsonResponse
    {
        $orders = Order::where('customer_id', $request->user()->id)->latest('id')->limit(20)
            ->with('items', 'shipments')->get()
            ->map(fn ($o) => [
                'order_no' => $o->order_no, 'status' => $o->status->value, 'total' => $o->total,
                'created_at' => $o->created_at->toIso8601String(), 'item_count' => $o->items->sum('qty'),
            ]);

        return response()->json(['data' => $orders]);
    }

    public function show(Request $request, string $orderNo): OrderDetailResource
    {
        $order = Order::where('order_no', $orderNo)->where('customer_id', $request->user()->id)
            ->with('items.brand', 'items.booking', 'shipments.items.variant', 'shipments.events')
            ->firstOrFail();

        return new OrderDetailResource($order);
    }
}
