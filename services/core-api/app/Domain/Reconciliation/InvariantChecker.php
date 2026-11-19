<?php

namespace App\Domain\Reconciliation;

use App\Domain\Settlement\StatementGenerator;
use App\Domain\Warehouse\WarehouseService;
use Illuminate\Support\Facades\DB;

/**
 * 不變式檢查：這些條件應該「永遠」成立。混沌測試跑完後，全部要是 0。
 */
class InvariantChecker
{
    /** Datadog 指標的 tag，順序和 check() 回傳的順序相同 */
    public const METRIC_TAGS = [
        'inventory_reserved', 'warehouse_balance', 'settlement_statement', 'payment_status',
        'refund_amount', 'settlement_entry', 'subscription_cycle', 'booking_payment', 'authorization_stuck',
        'reservation_leak',
    ];

    public function __construct(private WarehouseService $warehouse, private StatementGenerator $statements) {}

    /**
     * rows：違反的資料（最多 50 筆，每筆都有「實際」的欄位，例如 reserved 和 held）
     * order_nos：牽涉到的訂單（sandbox 報告用它找 log、做資料庫快照）；庫存、寄倉、結算這類不是以訂單為單位的會是空的
     *
     * @return array<string, array{ok: bool, count: int, detail: string, rows: array, order_nos: list<string>}>
     */
    public function check(): array
    {
        $checks = [];

        // 每一桶分開對：預留記著自己的桶號，實扣、釋放要回到同一桶（分桶，InventoryBuckets）
        $reservedMismatch = DB::select("
            SELECT i.variant_id, i.bucket_no, i.reserved, COALESCE(SUM(r.qty), 0) AS held
              FROM inventory i LEFT JOIN inventory_reservations r ON r.variant_id = i.variant_id AND r.bucket_no = i.bucket_no AND r.status = 'HELD'
             GROUP BY i.variant_id, i.bucket_no, i.reserved HAVING i.reserved <> COALESCE(SUM(r.qty), 0)");
        $checks['庫存：reserved = 未結案的預留加總（每一桶）'] = $reservedMismatch;

        $checks['寄倉：balance = 帳本加總'] = $this->warehouse->mismatchedAccounts();
        $checks['結算：結算單金額 = 分錄加總'] = $this->statements->mismatchedStatements();

        $checks['付款：訂單已付款 ⇔ 付款成功（失敗的訂單若被扣款，必須全額退款）'] = DB::select("
            SELECT o.order_no, o.status, p.status AS payment_status FROM orders o JOIN payments p ON p.order_id = o.id
             WHERE (o.status IN ('PAID','FULFILLING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED') AND p.status <> 'SUCCEEDED')
                OR (o.status = 'PENDING_PAYMENT' AND p.status = 'SUCCEEDED')
                OR (o.status IN ('PAYMENT_FAILED','CANCELLED') AND p.status = 'SUCCEEDED' AND p.refunded_amount <> p.amount)");

        $checks['退款：已退金額 = 退款單加總（處理中＋成功）'] = DB::select("
            SELECT o.order_no, p.id, p.refunded_amount, COALESCE(SUM(r.amount), 0) AS refunds
              FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN refunds r ON r.payment_id = p.id AND r.status IN ('PENDING','SUCCEEDED')
             GROUP BY o.order_no, p.id, p.refunded_amount HAVING p.refunded_amount <> COALESCE(SUM(r.amount), 0)");

        $checks['結算：每個已付款的供應商明細都有銷售分錄'] = DB::select("
            SELECT o.order_no, oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN legal_entities le ON le.id = oi.legal_entity_id
              LEFT JOIN settlement_entries e ON e.idempotency_key = CONCAT('sale:', oi.id)
             WHERE le.role = 'supplier' AND o.paid_at IS NOT NULL AND e.id IS NULL");

        $checks['訂閱：同一期不會有兩張訂單'] = DB::select('
            SELECT subscription_id, cycle_no, COUNT(*) c FROM subscription_cycles GROUP BY subscription_id, cycle_no HAVING c > 1');

        // 預約 TCC（§6.4.1）：醫院確認 ⇔ 請款；取消 ⇔ 沒有扣款
        $checks['預約：已確認才請款、已取消就不能扣款'] = DB::select("
            SELECT b.order_no, b.id, b.status, p.status AS payment_status FROM bookings b
              JOIN orders o ON o.order_no = b.order_no JOIN payments p ON p.order_id = o.id
             WHERE (b.status = 'CANCELLED' AND p.status = 'SUCCEEDED' AND p.refunded_amount <> p.amount)
                OR (b.status IN ('HELD', 'AUTHORIZED') AND p.status = 'SUCCEEDED')
                OR (b.status = 'CONFIRMED' AND p.status IN ('VOIDED', 'FAILED'))");

        $checks['授權：不能一直圈住客人的額度（超過上限未請款或取消）'] = DB::select("
            SELECT o.order_no, p.id, p.authorized_at FROM payments p JOIN orders o ON o.id = p.order_id
             WHERE p.status = 'AUTHORIZED' AND p.authorized_at < ?", [now()->subSeconds((int) config('shop.booking.authorization_max_seconds'))]);

        // 上面「reserved = 預留加總」只對得出兩邊一致：付款失敗忘了釋放的話，預留還是 HELD、reserved 也沒減，照樣一致，
        // 但那批庫存會永遠被佔住賣不出去 → 結案的訂單另外檢查
        $checks['庫存：付款失敗、取消的訂單不能還佔著預留'] = DB::select("
            SELECT o.order_no, o.status, r.variant_id, r.qty FROM orders o
              JOIN inventory_reservations r ON r.order_id = o.id AND r.status = 'HELD'
             WHERE o.status IN ('PAYMENT_FAILED', 'CANCELLED')");

        return collect($checks)->map(fn ($rows) => [
            'ok' => count($rows) === 0,
            'count' => count($rows),
            'detail' => count($rows) ? json_encode(array_slice($rows, 0, 3), JSON_UNESCAPED_UNICODE) : '',
            'rows' => array_slice($rows, 0, 50),
            'order_nos' => collect($rows)->pluck('order_no')->filter()->unique()->values()->all(),
        ])->all();
    }

    /** 還在處理中的東西（混沌測試要等這些歸零才檢查） */
    public function inFlight(): array
    {
        return [
            'pending_payment_orders' => DB::table('orders')->where('status', 'PENDING_PAYMENT')->count(),
            'outbox_pending' => DB::table('outbox_messages')->where('status', 'PENDING')->count(),
            'shipments_in_transit' => DB::table('shipments')->whereNotIn('status', ['DELIVERED', 'FAILED'])->count(),
            'bookings_pending' => DB::table('bookings as b')->join('orders as o', 'o.order_no', '=', 'b.order_no')
                ->whereIn('b.status', ['HELD', 'AUTHORIZED'])->whereNotIn('o.status', ['PAYMENT_FAILED', 'CANCELLED'])->count(),
            'authorizations_open' => DB::table('payments')->where('status', 'AUTHORIZED')->count(),
            'refunds_pending' => DB::table('refunds')->where('status', 'PENDING')->count(),
        ];
    }
}
