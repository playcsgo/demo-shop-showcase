<?php

namespace App\Http\Controllers\Api;

use App\Domain\Idempotency\IdempotencyStore;
use App\Domain\Warehouse\WarehouseService;
use App\Http\Controllers\Controller;
use App\Models\WarehouseAccount;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class WarehouseController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $accounts = WarehouseAccount::with('variant')->where('customer_id', $request->user()->id)->get()
            ->map(fn ($a) => ['variant_id' => $a->variant_id, 'name' => $a->variant->name, 'balance' => $a->balance]);

        return response()->json(['data' => $accounts]);
    }

    public function withdraw(Request $request, WarehouseService $warehouse): JsonResponse
    {
        $key = IdempotencyStore::requireKey($request->header('Idempotency-Key'));
        $data = $request->validate(['variant_id' => 'required|integer', 'qty' => 'required|integer|min:1|max:99']);
        $customerId = $request->user()->id;

        $withdrawal = $warehouse->withdraw($customerId, $data['variant_id'], $data['qty'], "{$customerId}:{$key}",
            $request->header('X-Correlation-Id') ?: (string) Str::uuid());

        return response()->json(['withdrawal_id' => $withdrawal->id, 'qty' => $withdrawal->qty, 'status' => $withdrawal->status], 201);
    }
}
