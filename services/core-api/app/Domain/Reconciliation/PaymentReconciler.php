<?php

namespace App\Domain\Reconciliation;

use App\Domain\Messaging\Outbox;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * 對帳（Saga 的最後防線，§6.3、§B7）：
 * webhook 可能永遠不來（廠商漏送、我們的 hub 掛掉、訊息進了 DLQ）。
 * PENDING_PAYMENT 超過時限的訂單 → 送 payment.reconcile.requested → hub 主動查金流 → 補上結果。
 */
class PaymentReconciler
{
    public function __construct(private Outbox $outbox) {}

    /**
     * 要問金流的只有兩種（還在佇列裡排隊的 PENDING 不問：金流根本還不知道這筆，問了只會讓積壓更嚴重——壓測抓到的）：
     *  - SUBMITTED：hub 已經送給金流、webhook 還沒來（可能遺失）→ 到了 next_reconcile_at 才問
     *  - 超過付款期限還是 PENDING：扣款指令可能進了 DLQ，或 hub 送出後來不及通知 → 最後確認（查無此筆才判定失敗）
     * 每問一次，下次就等更久：20 → 40 → 80 → … 秒，最多 payment_reconcile_max_interval_seconds（指數退避）
     *
     * @return int 這次發起查詢的筆數
     */
    public function run(int $limit = 50): int
    {
        $after = (int) config('shop.payment_reconcile_after_seconds');
        $cap = (int) config('shop.payment_reconcile_max_interval_seconds');
        $expireBefore = now()->subSeconds((int) config('shop.payment_expire_after_seconds'));

        $stale = DB::table('orders as o')->join('payments as p', 'p.order_id', '=', 'o.id')
            ->where('o.status', 'PENDING_PAYMENT')
            ->where(fn ($q) => $q
                ->where(fn ($q) => $q->where('p.status', 'SUBMITTED')->where('p.next_reconcile_at', '<=', now()))
                ->orWhere(fn ($q) => $q->where('p.status', 'PENDING')->where('o.created_at', '<', $expireBefore)
                    ->where(fn ($q) => $q->whereNull('p.next_reconcile_at')->orWhere('p.next_reconcile_at', '<=', now()))))
            ->orderBy('p.next_reconcile_at')->limit($limit)
            ->get(['o.id', 'o.order_no', 'o.correlation_id', 'o.created_at', 'p.id as payment_id', 'p.reconcile_attempts']);

        foreach ($stale as $row) {
            DB::transaction(function () use ($row, $expireBefore, $after, $cap) {
                DB::table('payments')->where('id', $row->payment_id)->update([
                    'last_reconciled_at' => now(), 'reconcile_attempts' => DB::raw('reconcile_attempts + 1'),
                    'next_reconcile_at' => now()->addSeconds(min($cap, $after * 2 ** min(10, $row->reconcile_attempts + 1))),
                ]);
                // expired：超過付款期限（比 SQS 重試窗口長）。只有 expired 且金流查不到，hub 才能判定失敗；
                // 期限內查不到可能是扣款請求還在佇列裡重試，此時判定失敗會造成「訂單失敗但客人被扣款」
                $this->outbox->record('payment.reconcile.requested', 'core-commands', [
                    'order_no' => $row->order_no,
                    'expired' => Carbon::parse($row->created_at)->lt($expireBefore),
                ], $row->correlation_id);
            });
        }

        return $stale->count();
    }

    /**
     * 預約 TCC 的防線（§6.4.1）：授權之後卡住的，重送下一步的指令（每一步都冪等，重送安全）。
     *  - AUTHORIZED 的預約遲遲沒有結果 → 重送 booking.confirm.requested（醫院的確認可以重複呼叫）
     *  - 預約已確認、付款還是 AUTHORIZED → 重送 payment.capture.requested
     *  - 訂單已取消／失敗、付款還是 AUTHORIZED → 重送 payment.void.requested
     * 不讓客人的額度一直被圈住。
     * 重送也用指數退避（next_reconcile_at）：指令可能只是還在佇列裡排隊，一直重送會讓積壓自己放大
     *
     * @return int 重送的指令數
     */
    public function redriveAuthorizations(int $limit = 50): int
    {
        $stuck = (int) config('shop.booking.stuck_after_seconds');
        $cap = (int) config('shop.payment_reconcile_max_interval_seconds');
        $before = now()->subSeconds($stuck);
        $n = 0;

        $rows = DB::table('payments as p')->join('orders as o', 'o.id', '=', 'p.order_id')
            ->leftJoin('bookings as b', 'b.order_no', '=', 'o.order_no')
            ->where('p.status', 'AUTHORIZED')
            ->where(fn ($q) => $q->where('p.next_reconcile_at', '<=', now())
                ->orWhere(fn ($q) => $q->whereNull('p.next_reconcile_at')->where('p.updated_at', '<', $before)))
            ->where(fn ($q) => $q->whereNull('b.id')->orWhere('b.updated_at', '<', $before))
            ->limit($limit)
            ->get(['p.id as payment_id', 'p.reconcile_attempts', 'p.provider_txn_id', 'p.amount', 'o.order_no', 'o.status as order_status', 'o.correlation_id',
                'b.id as booking_id', 'b.status as booking_status', 'b.hold_id', 'b.appointment_at']);

        foreach ($rows as $r) {
            DB::transaction(function () use ($r, &$n, $stuck, $cap) {
                [$type, $payload] = match (true) {
                    in_array($r->order_status, ['CANCELLED', 'PAYMENT_FAILED'], true) => ['payment.void.requested', ['order_no' => $r->order_no, 'provider_txn_id' => $r->provider_txn_id]],
                    $r->booking_status === 'CONFIRMED' => ['payment.capture.requested', ['order_no' => $r->order_no, 'provider_txn_id' => $r->provider_txn_id, 'amount' => $r->amount]],
                    $r->booking_status === 'AUTHORIZED' => ['booking.confirm.requested', ['booking_id' => $r->booking_id, 'hold_id' => $r->hold_id, 'order_no' => $r->order_no,
                        'appointment_at' => Carbon::parse($r->appointment_at)->timezone('Asia/Taipei')->toIso8601String()]],
                    default => [null, null],
                };
                if (! $type) {
                    return;
                }
                $this->outbox->record($type, 'core-commands', $payload, $r->correlation_id);
                // 下一次重送：60 → 120 → 240 → … 秒，最多 payment_reconcile_max_interval_seconds
                DB::table('payments')->where('id', $r->payment_id)->update([
                    'updated_at' => now(), 'reconcile_attempts' => DB::raw('reconcile_attempts + 1'),
                    'next_reconcile_at' => now()->addSeconds(min($cap, $stuck * 2 ** min(10, $r->reconcile_attempts + 1))),
                ]);
                if ($r->booking_id) {
                    DB::table('bookings')->where('id', $r->booking_id)->update(['updated_at' => now()]);
                }
                $n++;
            });
        }

        return $n;
    }
}
