<?php

namespace App\Http\Controllers\Api\B2b;

use App\Http\Controllers\Controller;
use App\Models\DistributorOrder;
use App\Models\DistributorOrderEvent;
use App\Models\DistributorUser;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** 經銷商的訂單和時間軸：只有狀態變化、時間和退回原因，內部人員是誰不外露 */
class OrderController extends Controller
{
    private const EVENT_LABELS = [
        'SUBMITTED' => '已送出', 'RESUBMITTED' => '已重新送出', 'REJECTED' => '已退回', 'APPROVED' => '審核通過',
        'PAYMENT_CONFIRMED' => '已確認收款', 'CANCELLED' => '已取消', 'FULFILMENT_STARTED' => '開始處理',
        'ORDER_COMPLETED' => '已完工', 'ORDER_SHIPPED' => '已出貨', 'ORDER_DELIVERED' => '已送達',
    ];

    public function index(Request $request): JsonResponse
    {
        $orders = $this->ownOrders($request)->with('batch', 'shop')->latest('id')->limit(100)->get();

        return response()->json(['data' => $orders->map($this->summary(...))]);
    }

    public function show(Request $request, string $orderNo): JsonResponse
    {
        $order = $this->ownOrders($request)->with('batch', 'shop')->where('order_no', $orderNo)->firstOrFail();

        // 整批的事件（order_id 是 NULL）和這張單自己的事件；別張單的完工、出貨不算
        $events = DistributorOrderEvent::where('batch_id', $order->batch_id)
            ->where(fn (Builder $q) => $q->whereNull('order_id')->orWhere('order_id', $order->id))
            ->orderBy('occurred_at')->orderBy('id')->get();

        return response()->json($this->summary($order) + [
            'timeline' => $events->map(fn (DistributorOrderEvent $e) => [
                'type' => $e->type, 'label' => self::EVENT_LABELS[$e->type] ?? $e->type,
                'occurred_at' => $e->occurred_at->toIso8601String(), 'note' => $e->note,
            ])->all(),
        ]);
    }

    /** @return Builder<DistributorOrder> */
    private function ownOrders(Request $request): Builder
    {
        /** @var DistributorUser $user */
        $user = $request->user();

        return DistributorOrder::whereHas('batch', fn (Builder $q) => $q->where('distributor_id', $user->distributor_id));
    }

    /** @return array<string, mixed> */
    private function summary(DistributorOrder $o): array
    {
        return [
            'order_no' => $o->order_no, 'status' => $o->status->value, 'order_type' => $o->batch->order_type->value, 'eta_date' => $o->eta_date?->toDateString(), 'batch_no' => $o->batch->batch_no, 'batch_status' => $o->batch->status->value,
            'shop_name' => $o->shop->name, 'requested_ship_date' => $o->requested_ship_date?->toDateString(),
            'subtotal_minor' => $o->subtotal_minor, 'currency' => $o->batch->currency, 'shipped_at' => $o->shipped_at?->toIso8601String(), 'delivered_at' => $o->delivered_at?->toIso8601String(),
        ];
    }
}
