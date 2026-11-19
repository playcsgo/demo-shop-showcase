<?php

namespace App\Models;

use App\Domain\Distribution\BatchPricer;
use App\Enums\BatchFollowUp;
use App\Enums\DistributorBatchStatus;
use App\Enums\DistributorOrderStatus;
use App\Enums\DistributorOrderType;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** 一次送出的所有單。審核、付款、排產都在這層 */
class DistributorBatch extends Model
{
    protected $casts = [
        'order_type' => DistributorOrderType::class, 'status' => DistributorBatchStatus::class,
        'submitted_at' => 'datetime', 'anticipated_response_date' => 'date',
        'warnings' => 'array', 'moq_results' => 'array',
        'reviewed_at' => 'datetime', 'approved_at' => 'datetime', 'payment_confirmed_at' => 'datetime', 'cancelled_at' => 'datetime',
    ];

    /** 付款期限：核准後幾天。只標紅，由業務決定是否取消 */
    public const PAYMENT_DUE_DAYS = 7;

    /** 超過預計回覆日只標紅，不會自動通過。日期用台北時間算 */
    public function isResponseOverdue(): bool
    {
        return $this->status === DistributorBatchStatus::InReview
            && now(BatchPricer::BUSINESS_TIMEZONE)->toDateString() > $this->anticipated_response_date->toDateString();
    }

    public function isPaymentOverdue(): bool
    {
        return $this->status === DistributorBatchStatus::AwaitingPayment
            && $this->approved_at?->copy()->addDays(self::PAYMENT_DUE_DAYS)->isPast();
    }

    /**
     * 輪到業務動作的批次。ETA 選填：沒填的單也算，不然生產中的單沒有任何提醒。ETA 當天還不算過期
     *
     * @param  Builder<self>  $query
     */
    public function scopeNeedsAction(Builder $query): void
    {
        $query->where(fn (Builder $q) => $q
            ->whereIn('status', [DistributorBatchStatus::InReview, DistributorBatchStatus::AwaitingStart])
            ->orWhere(fn (Builder $q) => $q->where('status', DistributorBatchStatus::AwaitingPayment)->where('approved_at', '<', now()->subDays(self::PAYMENT_DUE_DAYS)))
            ->orWhere(fn (Builder $q) => $q->where('status', DistributorBatchStatus::Processing)->whereHas('orders', fn (Builder $o) => $o
                ->whereIn('status', [DistributorOrderStatus::InProgress, DistributorOrderStatus::Shipped])
                ->where(fn (Builder $o) => $o->whereNull('eta_date')->orWhere('eta_date', '<', now(BatchPricer::BUSINESS_TIMEZONE)->toDateString())))));
    }

    public function followUp(): BatchFollowUp
    {
        return match (true) {
            in_array($this->status, [DistributorBatchStatus::Completed, DistributorBatchStatus::Cancelled], true) => BatchFollowUp::Ended,
            self::whereKey($this->id)->needsAction()->exists() => BatchFollowUp::NeedsAction,
            default => BatchFollowUp::Waiting,
        };
    }

    /** @return BelongsTo<Distributor, $this> */
    public function distributor(): BelongsTo
    {
        return $this->belongsTo(Distributor::class);
    }

    /** @return HasMany<DistributorOrder, $this> */
    public function orders(): HasMany
    {
        return $this->hasMany(DistributorOrder::class, 'batch_id');
    }

    /** @return HasMany<DistributorBatchRevision, $this> */
    public function revisions(): HasMany
    {
        return $this->hasMany(DistributorBatchRevision::class, 'batch_id');
    }

    /** @return HasMany<DistributorOrderEvent, $this> */
    public function events(): HasMany
    {
        return $this->hasMany(DistributorOrderEvent::class, 'batch_id');
    }
}
