<?php

namespace App\Domain\Catalog;

use App\Domain\DomainException;
use App\Enums\ReservationStatus;
use Illuminate\Support\Facades\DB;

/**
 * 庫存：預留 → 實扣／釋放。qty 的單位是件，不是箱。
 *
 * 「檢查」和「修改」必須是同一個動作，中間不能有空窗：
 *   UPDATE … SET reserved = reserved + 1 WHERE … AND on_hand - reserved >= 1
 * MySQL 會鎖住這一列再判斷條件，第二個人等第一個人 commit 後才判斷。
 * 呼叫端負責開交易：預留要和建立訂單在同一個交易，訂單沒建成，預留也要退回
 */
class InventoryService
{
    /** 現貨單送出時預留。不夠 → DomainException */
    public function reserve(int $orderId, int $productId, int $qty): void
    {
        $won = DB::update('UPDATE inventory SET reserved = reserved + ?, updated_at = NOW() WHERE product_id = ? AND on_hand - reserved >= ?', [$qty, $productId, $qty]);
        if ($won === 0) {
            throw new DomainException('insufficient_stock', '庫存不足', 409);
        }

        DB::table('inventory_reservations')->insert([
            'distributor_order_id' => $orderId, 'product_id' => $productId, 'qty' => $qty,
            'status' => ReservationStatus::Held->value, 'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    /** 現貨單出貨：預留轉成真的扣掉。重複呼叫安全 */
    public function commit(int $orderId): void
    {
        $this->settle($orderId, ReservationStatus::Committed, 'on_hand = on_hand - ?, reserved = reserved - ?');
    }

    /** 批次被退回或取消：預留還回去。重複呼叫安全 */
    public function release(int $orderId): void
    {
        $this->settle($orderId, ReservationStatus::Released, 'reserved = reserved - ?');
    }

    /**
     * 後台調整庫存：+入庫、−盤損。用增減而不是設定數字，才不會蓋掉同一時間的預留。
     * 調整後不能少於已預留的數量
     */
    public function adjust(int $productId, int $delta): void
    {
        if ($delta === 0) {
            return;
        }
        $ok = $delta > 0
            ? DB::update('UPDATE inventory SET on_hand = on_hand + ?, updated_at = NOW() WHERE product_id = ?', [$delta, $productId])
            : DB::update('UPDATE inventory SET on_hand = on_hand - ?, updated_at = NOW() WHERE product_id = ? AND on_hand - reserved >= ?', [-$delta, $productId, -$delta]);
        if (! $ok) {
            throw new DomainException('stock_below_reserved', '調整後的庫存會少於已經被預留的數量', 422);
        }
    }

    private function settle(int $orderId, ReservationStatus $to, string $set): void
    {
        DB::transaction(function () use ($orderId, $to, $set) {
            $held = DB::table('inventory_reservations')->where('distributor_order_id', $orderId)->where('status', ReservationStatus::Held)->get();

            foreach ($held as $r) {
                // 先搶下這筆預留（HELD → 目標狀態），搶到的程序才去動庫存：同一張單重複處理也只扣一次
                $won = DB::table('inventory_reservations')->where('id', $r->id)->where('status', ReservationStatus::Held)
                    ->update(['status' => $to, 'updated_at' => now()]);

                if ($won === 1) {
                    $bindings = array_fill(0, substr_count($set, '?'), $r->qty);
                    DB::update("UPDATE inventory SET {$set}, updated_at = NOW() WHERE product_id = ?", [...$bindings, $r->product_id]);
                }
            }
        });
    }
}
