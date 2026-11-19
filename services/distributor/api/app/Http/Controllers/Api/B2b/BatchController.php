<?php

namespace App\Http\Controllers\Api\B2b;

use App\Domain\Distribution\BatchPricer;
use App\Domain\Distribution\BatchSubmission;
use App\Domain\DomainException;
use App\Enums\DistributorBatchStatus;
use App\Http\Controllers\Controller;
use App\Http\Requests\B2b\SubmitBatchRequest;
use App\Models\DistributorBatch;
use App\Models\DistributorBatchRevision;
use App\Models\DistributorOrder;
use App\Models\DistributorOrderItem;
use App\Models\DistributorUser;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class BatchController extends Controller
{
    public function preview(SubmitBatchRequest $request, BatchPricer $pricer): JsonResponse
    {
        return response()->json($pricer->price($this->user($request)->load('distributor')->distributor, $request->validated()));
    }

    public function store(SubmitBatchRequest $request, BatchSubmission $submission): JsonResponse
    {
        $key = $request->header('Idempotency-Key');
        if (! $key || strlen($key) > 80) {
            throw new DomainException('idempotency_key_required', '請帶 Idempotency-Key 標頭（80 字以內）', 400);
        }
        $batch = $submission->submit($this->user($request), $request->validated(), $key);

        return response()->json($this->detail($batch), $batch->wasRecentlyCreated ? 201 : 200);
    }

    public function index(Request $request): JsonResponse
    {
        $batches = DistributorBatch::where('distributor_id', $this->user($request)->distributor_id)->latest('id')->limit(100)->get();

        return response()->json(['data' => $batches->map($this->summary(...))]);
    }

    public function show(Request $request, string $batchNo): JsonResponse
    {
        return response()->json($this->detail($this->ownBatch($request, $batchNo)));
    }

    public function resubmit(SubmitBatchRequest $request, string $batchNo, BatchSubmission $submission): JsonResponse
    {
        return response()->json($this->detail($submission->resubmit($this->user($request), $this->ownBatch($request, $batchNo), $request->validated())));
    }

    /** 歷次送出的內容和退回原因。不含內部人員資料 */
    public function revisions(Request $request, string $batchNo): JsonResponse
    {
        $revisions = $this->ownBatch($request, $batchNo)->revisions()->orderBy('revision')->get();

        return response()->json(['data' => $revisions->map(fn (DistributorBatchRevision $r) => [
            'revision' => $r->revision, 'submitted_at' => $r->submitted_at->toIso8601String(),
            'reject_reason' => $r->reject_reason, 'rejected_at' => $r->rejected_at?->toIso8601String(),
            'total_minor' => $r->snapshot['total_minor'], 'order_type' => $r->snapshot['order_type'], 'orders' => $r->snapshot['orders'],
        ])]);
    }

    private function user(Request $request): DistributorUser
    {
        /** @var DistributorUser */
        return $request->user();
    }

    private function ownBatch(Request $request, string $batchNo): DistributorBatch
    {
        return DistributorBatch::where('distributor_id', $this->user($request)->distributor_id)->where('batch_no', $batchNo)->firstOrFail();
    }

    /** @return array<string, mixed> */
    private function summary(DistributorBatch $b): array
    {
        return [
            'batch_no' => $b->batch_no, 'order_type' => $b->order_type->value, 'status' => $b->status->value,
            'currency' => $b->currency, 'total_minor' => $b->total_minor, 'prepay_minor' => $b->prepay_minor, 'prepay_bps' => $b->prepay_bps,
            'revision' => $b->revision, 'submitted_at' => $b->submitted_at->toIso8601String(),
            'anticipated_response_date' => $b->anticipated_response_date->toDateString(),
        ];
    }

    /** @return array<string, mixed> */
    private function detail(DistributorBatch $b): array
    {
        $orders = $b->orders()->with('shop', 'items.product')->orderBy('id')->get();

        return $this->summary($b) + [
            'reject_reason' => $b->status === DistributorBatchStatus::Rejected ? $b->revisions()->where('revision', $b->revision)->value('reject_reason') : null,
            'warnings' => $b->warnings,
            'moq_results' => $b->moq_results,
            'orders' => $orders->map(fn (DistributorOrder $o) => [
                'order_no' => $o->order_no, 'status' => $o->status->value, 'eta_date' => $o->eta_date?->toDateString(), 'shop_id' => $o->shop_id, 'shop_name' => $o->shop->name,
                'requested_ship_date' => $o->requested_ship_date?->toDateString(), 'subtotal_minor' => $o->subtotal_minor,
                'items' => $o->items->map(fn (DistributorOrderItem $i) => $i->only('product_id', 'qty_cases', 'case_size', 'qty_units', 'unit_price_minor', 'amount_minor', 'hs_code') + ['sku' => $i->product->sku])->all(),
            ])->all(),
        ];
    }
}
