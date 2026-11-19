<?php

namespace App\Domain\Settlement;

use App\Domain\DomainException;
use App\Models\SettlementStatement;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * 月結（§5.2）：把「還沒結算、且發生在月底之前」的分錄掛到該月結算單。
 * 已結算的月份又發生退款 → 退款分錄 statement_id 是 null → 自然進下個月的結算單（不改舊單）。
 */
class StatementGenerator
{
    public function generate(int $legalEntityId, string $period): SettlementStatement
    {
        $periodEnd = Carbon::createFromFormat('Y-m-d', "{$period}-01")->startOfMonth()->addMonth();

        return DB::transaction(function () use ($legalEntityId, $period, $periodEnd) {
            $statement = SettlementStatement::firstOrCreate(
                ['legal_entity_id' => $legalEntityId, 'period' => $period],
                ['status' => 'DRAFT'],
            );
            $statement = SettlementStatement::whereKey($statement->id)->lockForUpdate()->first();

            if ($statement->status !== 'DRAFT') {
                throw new DomainException('statement_closed', "{$period} 已確認，不能再變動", 409);
            }

            DB::table('settlement_entries')
                ->where('legal_entity_id', $legalEntityId)
                ->whereNull('statement_id')
                ->where('occurred_at', '<', $periodEnd)
                ->update(['statement_id' => $statement->id]);

            $totals = DB::table('settlement_entries')->where('statement_id', $statement->id)
                ->selectRaw("
                    COALESCE(SUM(CASE WHEN type = 'SALE' THEN amount END), 0) AS gross,
                    COALESCE(SUM(CASE WHEN type = 'REFUND' THEN amount END), 0) AS refunds,
                    COALESCE(SUM(CASE WHEN type = 'COMMISSION' THEN amount END), 0) AS commission,
                    COALESCE(SUM(CASE WHEN type = 'PAYMENT_FEE' THEN amount END), 0) AS fees,
                    COALESCE(SUM(amount), 0) AS payable")
                ->first();

            $statement->update((array) $totals);

            return $statement->fresh();
        });
    }

    public function confirm(SettlementStatement $statement, int $userId, ?string $supplierInvoiceNo = null): bool
    {
        return SettlementStatement::whereKey($statement->id)->where('status', 'DRAFT')->update([
            'status' => 'CONFIRMED', 'confirmed_by' => $userId, 'confirmed_at' => now(),
            'supplier_invoice_no' => $supplierInvoiceNo, 'updated_at' => now(),
        ]) === 1;
    }

    /** 對帳：結算單金額 ≠ 分錄加總（應該永遠是空的） */
    public function mismatchedStatements(): array
    {
        return DB::select(
            'SELECT s.id, s.payable, COALESCE(SUM(e.amount), 0) AS entries_sum
               FROM settlement_statements s LEFT JOIN settlement_entries e ON e.statement_id = s.id
              GROUP BY s.id, s.payable
             HAVING s.payable <> COALESCE(SUM(e.amount), 0)'
        );
    }
}
