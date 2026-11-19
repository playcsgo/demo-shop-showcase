<?php

namespace App\Domain\Reconciliation;

use Illuminate\Support\Facades\DB;

/** 帳對不對：這些查詢正常都要是 0 筆。主控台和測試都用這一份 */
class InvariantChecker
{
    /** @return array<string, array{ok: bool, count: int, rows: array<int, object>}> */
    public function check(): array
    {
        $checks = [
            '庫存：reserved = 還沒結案的預留加總' => DB::select("
                SELECT i.product_id, i.reserved, COALESCE(SUM(r.qty), 0) AS held
                  FROM inventory i LEFT JOIN inventory_reservations r
                    ON r.product_id = i.product_id AND r.status = 'HELD'
                 GROUP BY i.product_id, i.reserved HAVING i.reserved <> COALESCE(SUM(r.qty), 0)"),

            // 上面那項只對得出兩邊一致：退回忘了釋放，預留還是 HELD、reserved 也沒減，帳一樣對得上
            '庫存：已退回、已取消的批次不能還佔著預留' => DB::select("
                SELECT b.batch_no, r.product_id, r.qty FROM distributor_batches b
                  JOIN distributor_orders o ON o.batch_id = b.id
                  JOIN inventory_reservations r ON r.distributor_order_id = o.id AND r.status = 'HELD'
                 WHERE b.status IN ('REJECTED', 'CANCELLED')"),
        ];

        return array_map(fn (array $rows) => ['ok' => $rows === [], 'count' => count($rows), 'rows' => $rows], $checks);
    }
}
