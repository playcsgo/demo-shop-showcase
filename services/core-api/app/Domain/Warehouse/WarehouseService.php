<?php

namespace App\Domain\Warehouse;

use App\Domain\DomainException;
use App\Domain\Messaging\Outbox;
use App\Models\ProductVariant;
use App\Models\Withdrawal;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * 寄倉帳本（§5.6）：
 *  - warehouse_ledger 只新增不修改；balance 是加總的快取，兩者同一個交易更新
 *  - 不變式：balance = SUM(ledger.delta)
 *  - idempotency_key 唯一：同一件事（同一筆訂單明細入帳、同一次提領）只記一次
 */
class WarehouseService
{
    public function __construct(private Outbox $outbox) {}

    /** 入帳（訂單付款成功時）。回傳 false＝這筆已入帳過。 */
    public function deposit(int $customerId, int $variantId, int $qty, string $refType, int $refId, string $idempotencyKey): bool
    {
        return DB::transaction(function () use ($customerId, $variantId, $qty, $refType, $refId, $idempotencyKey) {
            $accountId = $this->accountId($customerId, $variantId);

            if (! $this->appendLedger($accountId, $qty, 'DEPOSIT', $refType, $refId, $idempotencyKey)) {
                return false;
            }

            DB::update('UPDATE warehouse_accounts SET balance = balance + ?, updated_at = NOW() WHERE id = ?', [$qty, $accountId]);

            return true;
        });
    }

    /** 提領：扣餘額 → 記帳 → 建提領單與包裹 → outbox 出貨要求，全部同一個交易 */
    public function withdraw(int $customerId, int $variantId, int $qty, string $idempotencyKey, string $correlationId): Withdrawal
    {
        if ($existing = Withdrawal::where('idempotency_key', $idempotencyKey)->first()) {
            return $existing; // 客戶重按、網路重送 → 回同一筆
        }

        try {
            return DB::transaction(function () use ($customerId, $variantId, $qty, $idempotencyKey, $correlationId) {
                $accountId = DB::table('warehouse_accounts')
                    ->where(['customer_id' => $customerId, 'variant_id' => $variantId])->value('id')
                    ?? throw new DomainException('no_warehouse_account', '沒有寄倉餘額', 409);

                // 條件式扣減：餘額不足時影響 0 列，不會變成負數（CHECK 是第二道防線）
                $affected = DB::update(
                    'UPDATE warehouse_accounts SET balance = balance - ?, updated_at = NOW() WHERE id = ? AND balance >= ?',
                    [$qty, $accountId, $qty],
                );
                if ($affected === 0) {
                    throw new DomainException('insufficient_balance', '寄倉餘額不足', 409);
                }

                $withdrawal = Withdrawal::create([
                    'account_id' => $accountId, 'qty' => $qty, 'status' => 'REQUESTED', 'idempotency_key' => $idempotencyKey,
                ]);
                $this->appendLedger($accountId, -$qty, 'WITHDRAW', 'withdrawal', $withdrawal->id, "withdraw:{$idempotencyKey}");

                $variant = ProductVariant::with('product.brand')->findOrFail($variantId);
                $shipmentId = DB::table('shipments')->insertGetId([
                    'withdrawal_id' => $withdrawal->id, 'seq' => 1,
                    'shipping_class' => $variant->shipping_class->value,
                    'carrier' => $variant->shipping_class->carrier(),
                    'shipping_class' => $variant->shipping_class->value,   // AIC-017
                    'status' => 'REQUESTED', 'shipping_fee' => 0,
                    'created_at' => now(), 'updated_at' => now(),
                ]);
                DB::table('shipment_items')->insert(['shipment_id' => $shipmentId, 'variant_id' => $variantId, 'qty' => $qty]);

                $this->outbox->record('shipment.requested', 'core-commands', [
                    'shipment_id' => $shipmentId,
                    'source' => 'withdrawal',
                    'withdrawal_id' => $withdrawal->id,
                    'carrier' => $variant->shipping_class->carrier(),
                    'shipping_class' => $variant->shipping_class->value,   // AIC-017
                    'items' => [['sku' => $variant->sku, 'qty' => $qty]],
                ], $correlationId, $variant->product->brand->project_code);

                return $withdrawal;
            });
        } catch (UniqueConstraintViolationException) {
            // 兩個同 key 的請求同時進來：輸的那個回傳贏家建立的那筆
            return Withdrawal::where('idempotency_key', $idempotencyKey)->firstOrFail();
        }
    }

    /** 寄倉明細退款：扣回尚未提領的數量 */
    public function reverseDeposit(int $customerId, int $variantId, int $qty, string $refType, int $refId, string $idempotencyKey): bool
    {
        return DB::transaction(function () use ($customerId, $variantId, $qty, $refType, $refId, $idempotencyKey) {
            $accountId = $this->accountId($customerId, $variantId);

            if (! $this->appendLedger($accountId, -$qty, 'REFUND', $refType, $refId, $idempotencyKey)) {
                return false;
            }

            $affected = DB::update(
                'UPDATE warehouse_accounts SET balance = balance - ?, updated_at = NOW() WHERE id = ? AND balance >= ?',
                [$qty, $accountId, $qty],
            );
            if ($affected === 0) {
                throw new DomainException('already_withdrawn', '寄倉商品已提領，不能退款', 409);
            }

            return true;
        });
    }

    /** 對帳：回傳 balance ≠ 帳本加總 的帳戶（應該永遠是空的） */
    public function mismatchedAccounts(): array
    {
        return DB::select(
            'SELECT a.id, a.balance, COALESCE(SUM(l.delta), 0) AS ledger_sum
               FROM warehouse_accounts a LEFT JOIN warehouse_ledger l ON l.account_id = a.id
              GROUP BY a.id, a.balance
             HAVING a.balance <> COALESCE(SUM(l.delta), 0)'
        );
    }

    private function accountId(int $customerId, int $variantId): int
    {
        DB::table('warehouse_accounts')->insertOrIgnore([
            'customer_id' => $customerId, 'variant_id' => $variantId, 'balance' => 0,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        return DB::table('warehouse_accounts')->where(['customer_id' => $customerId, 'variant_id' => $variantId])->value('id');
    }

    /** @return bool false＝同一個 idempotency_key 已經記過 */
    private function appendLedger(int $accountId, int $delta, string $reason, string $refType, int $refId, string $key): bool
    {
        return DB::table('warehouse_ledger')->insertOrIgnore([
            'account_id' => $accountId, 'delta' => $delta, 'reason' => $reason,
            'ref_type' => $refType, 'ref_id' => $refId, 'idempotency_key' => $key, 'created_at' => now(),
        ]) === 1;
    }
}
