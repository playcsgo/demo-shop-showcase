<?php

namespace App\Http\Controllers\Api;

use App\Domain\Checkout\CheckoutService;
use App\Domain\Idempotency\IdempotencyStore;
use App\Http\Controllers\Controller;
use App\Http\Resources\OrderDetailResource;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class CheckoutController extends Controller
{
    /** 結帳：必須帶 Idempotency-Key（按兩次「結帳」或網路重送，都只會有一張訂單） */
    public function store(Request $request, CheckoutService $checkout, IdempotencyStore $idempotency): JsonResponse
    {
        $key = IdempotencyStore::requireKey($request->header('Idempotency-Key'));
        $utm = $request->validate([
            'utm_source' => 'nullable|string|max:50',
            'utm_medium' => 'nullable|string|max:50',
            'utm_campaign' => 'nullable|string|max:100',
        ]);
        $customer = $request->user();
        $correlationId = $request->header('X-Correlation-Id') ?: (string) Str::uuid();

        [$body, $status, $replayed] = $idempotency->run($customer->id, $key, hash('sha256', json_encode($utm)), function () use ($checkout, $customer, $utm, $correlationId) {
            $order = $checkout->checkout($customer, $utm, $correlationId);

            return [(new OrderDetailResource($order->fresh(['items.brand', 'items.booking', 'shipments'])))->resolve(), 201];
        });

        return response()->json($body, $status)->header('Idempotent-Replayed', $replayed ? 'true' : 'false');
    }
}
