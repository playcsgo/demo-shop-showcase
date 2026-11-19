<?php

namespace App\Domain\Settlement;

use App\Models\Order;
use App\Models\RefundItem;
use Illuminate\Support\Facades\DB;

/**
 * 結算分錄（§5.2）：汪是唯一賣方，只有「供應商（喵）」的明細需要記應付款。
 * 汪自己的品牌（AK、SB）只做內部拆帳，報表從 order_items 直接統計，不寫分錄。
 *
 * 金額方向：正數＝汪應付給供應商；負數＝從應付中扣除。
 */
class SettlementRecorder
{
    /** 訂單付款成功：每個供應商明細寫 SALE（＋）、COMMISSION（−）、PAYMENT_FEE（−）。重複呼叫安全。 */
    public function recordSale(Order $order): void
    {
        $order->loadMissing('items');
        $feeBps = (int) config('shop.payment_fee_bps');

        foreach ($order->items as $item) {
            if ($item->commission_bps === 0 && ! $this->isSupplier($item->legal_entity_id)) {
                continue; // 汪自己的品牌
            }

            $base = ['legal_entity_id' => $item->legal_entity_id, 'brand_id' => $item->brand_id,
                'ref_type' => 'order_item', 'ref_id' => $item->id, 'occurred_at' => $order->paid_at ?? now()];

            $this->append($base + ['type' => 'SALE', 'amount' => $item->line_total, 'idempotency_key' => "sale:{$item->id}"]);
            $this->append($base + ['type' => 'COMMISSION', 'amount' => -self::bps($item->line_total, $item->commission_bps), 'idempotency_key' => "commission:{$item->id}"]);
            $this->append($base + ['type' => 'PAYMENT_FEE', 'amount' => -self::bps($item->line_total, $feeBps), 'idempotency_key' => "fee:{$item->id}"]);
        }
    }

    /** 退款成功：REFUND（−）＋ 抽成回沖（＋）。金流手續費通常不退，不回沖。 */
    public function recordRefund(RefundItem $refundItem): void
    {
        $item = $refundItem->orderItem;
        if ($item->commission_bps === 0 && ! $this->isSupplier($item->legal_entity_id)) {
            return;
        }

        $base = ['legal_entity_id' => $item->legal_entity_id, 'brand_id' => $item->brand_id,
            'ref_type' => 'refund_item', 'ref_id' => $refundItem->id, 'occurred_at' => now()];

        $this->append($base + ['type' => 'REFUND', 'amount' => -$refundItem->amount, 'idempotency_key' => "refund:{$refundItem->id}"]);
        $this->append($base + ['type' => 'COMMISSION', 'amount' => self::bps($refundItem->amount, $item->commission_bps), 'idempotency_key' => "refund-commission:{$refundItem->id}"]);
    }

    /** 萬分比、無條件捨去（尾差留在汪） */
    public static function bps(int $amount, int $bps): int
    {
        return intdiv($amount * $bps, 10000);
    }

    private function isSupplier(int $legalEntityId): bool
    {
        return DB::table('legal_entities')->where('id', $legalEntityId)->value('role') === 'supplier';
    }

    private function append(array $row): void
    {
        DB::table('settlement_entries')->insertOrIgnore($row + ['created_at' => now()]);
    }
}
