<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Subscription;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SubscriptionController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $subs = Subscription::with('variant')->where('customer_id', $request->user()->id)->latest('id')->get()
            ->map(fn ($s) => [
                'id' => $s->id, 'product' => $s->variant->name, 'qty' => $s->qty, 'status' => $s->status,
                'cycles_done' => $s->next_cycle_no - 1, 'total_cycles' => $s->total_cycles,
                'next_run_at' => $s->status === 'ACTIVE' ? $s->next_run_at->toIso8601String() : null,
            ]);

        return response()->json(['data' => $subs]);
    }
}
