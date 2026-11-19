<?php

namespace App\Domain\Catalog;

use App\Domain\DomainException;
use App\Http\Controllers\Api\CatalogController;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * 庫存：預留 → 實扣／釋放（§5.3）。
 * 檢查和修改之間沒有空窗：條件式 UPDATE，或先上鎖（SELECT … FOR UPDATE）再改，所以併發也不會超賣。
 * 呼叫端負責開交易（和建立訂單、寫 outbox 在同一個交易）。
 * 只有這個類別知道庫存分成幾桶：結帳、付款、退款、後台都不用改，桶數變了也一樣（InventoryBuckets 負責拆／併）。
 */
class InventoryService
{
    /**
     * 預留庫存。商品可能分成好幾桶（熱賣模式，見 InventoryBuckets），挑桶的方式：
     *   1. 不上鎖地看一眼哪些桶還有貨，隨機排順序（大家不會都先去搶同一桶）
     *   2. 一桶一桶 SELECT … FOR UPDATE SKIP LOCKED：別人正在用的桶直接跳過，不排隊；
     *      只有資料庫知道哪一列正被鎖著，所以讓它來挑（不用 Redis 分配）
     *   3. 全部的桶都在忙（或只剩忙的桶有貨）→ 照桶號順序排隊等，不會因為「大家都在忙」就誤判成賣完
     * 一桶不夠就從下一桶補（快賣完時貨散在好幾桶）：一桶一筆預留紀錄，實扣、釋放回到同一桶。
     * 鎖住之後讀到的是最新的數字（上鎖的讀不看快照），扣多少就是多少，任何一桶都不會超賣（還有 CHECK 擋著）。
     * 一般商品只有桶 0，結果和原本一樣。
     */
    public function reserve(int $orderId, int $variantId, int $qty, Carbon $expiresAt): void
    {
        $taken = [];   // bucket_no => 預留了幾件
        $candidates = DB::table('inventory')->where('variant_id', $variantId)->whereRaw('on_hand > reserved')
            ->pluck('bucket_no')->shuffle()->all();
        $remaining = $this->takeFrom($variantId, $candidates, $qty, $taken, skipLocked: true);

        if ($remaining > 0) {
            $all = DB::table('inventory')->where('variant_id', $variantId)->orderBy('bucket_no')->pluck('bucket_no')->all();
            $remaining = $this->takeFrom($variantId, $all, $remaining, $taken, skipLocked: false);
        }

        if ($remaining > 0) {
            // 前面已經預留的幾桶由交易回滾還回去（呼叫端負責開交易）
            throw new DomainException('insufficient_stock', "variant {$variantId} 庫存不足", 409);
        }

        DB::table('inventory_reservations')->insert(array_map(fn (int $bucket, int $n) => [
            'order_id' => $orderId, 'variant_id' => $variantId, 'bucket_no' => $bucket, 'qty' => $n,
            'status' => 'HELD', 'expires_at' => $expiresAt, 'created_at' => now(), 'updated_at' => now(),
        ], array_keys($taken), $taken));
    }

    /**
     * 依序從這些桶預留，回傳還差幾件
     *
     * @param  list<int>  $buckets
     * @param  array<int, int>  $taken
     */
    private function takeFrom(int $variantId, array $buckets, int $remaining, array &$taken, bool $skipLocked): int
    {
        foreach ($buckets as $bucket) {
            if ($remaining === 0) {
                break;
            }
            if (isset($taken[$bucket])) {
                continue;   // 這一桶已經拿光了（沒拿光的話不會還差）
            }
            $row = DB::selectOne('SELECT on_hand - reserved AS available FROM inventory WHERE variant_id = ? AND bucket_no = ? FOR UPDATE'
                .($skipLocked ? ' SKIP LOCKED' : ''), [$variantId, $bucket]);
            if (! $row || $row->available <= 0) {
                continue;   // 別人正在用（SKIP LOCKED 跳過），或這一桶沒貨了
            }

            $n = min((int) $row->available, $remaining);
            DB::update('UPDATE inventory SET reserved = reserved + ?, updated_at = NOW() WHERE variant_id = ? AND bucket_no = ?', [$n, $variantId, $bucket]);
            $taken[$bucket] = $n;
            $remaining -= $n;
        }

        return $remaining;
    }

    /** 付款成功：預留轉實扣。重複呼叫安全（只有 HELD 的會被處理）。 */
    public function commit(int $orderId): void
    {
        $this->settle($orderId, 'COMMITTED', 'on_hand = on_hand - ?, reserved = reserved - ?');
    }

    /** 付款失敗、取消、逾時：釋放預留。重複呼叫安全。 */
    public function release(int $orderId): void
    {
        $this->settle($orderId, 'RELEASED', 'reserved = reserved - ?');
    }

    /** 退款回補（尚未出貨的直送商品）：加回桶 0，有分桶的話平衡排程會再分出去 */
    public function restock(int $variantId, int $qty): void
    {
        DB::update('UPDATE inventory SET on_hand = on_hand + ?, updated_at = NOW() WHERE variant_id = ? AND bucket_no = 0', [$qty, $variantId]);
    }

    /**
     * 後台調整庫存：+入庫、−盤損。
     * 用「增減」而不是「直接設定成某個數字」：管理員開著表單時可能正好有訂單扣了庫存，
     * 直接存表單上的舊數字會把那幾筆扣除蓋掉（lost update）→ 超賣。增減和結帳一樣是條件式 UPDATE。
     * 調整後不能少於已預留的數量（客人已經下單、還沒付款的）。
     * 入庫加到桶 0（平衡排程會分到其他桶）；盤損從可賣最多的桶開始扣，一桶不夠再扣下一桶。
     */
    public function adjust(int $variantId, int $delta): void
    {
        if ($delta === 0) {
            return;
        }

        if ($delta > 0) {
            $ok = DB::update('UPDATE inventory SET on_hand = on_hand + ?, updated_at = NOW() WHERE variant_id = ? AND bucket_no = 0', [$delta, $variantId]) === 1;
        } else {
            $ok = DB::transaction(function () use ($variantId, $delta) {
                // 照桶號順序上鎖（和平衡排程同一個順序，不會互相等對方）；後台偶爾才調一次，排隊沒關係
                $buckets = collect(DB::select('SELECT bucket_no, on_hand - reserved AS available FROM inventory WHERE variant_id = ? ORDER BY bucket_no FOR UPDATE', [$variantId]));
                if ($buckets->isEmpty() || $buckets->sum('available') < -$delta) {
                    return false;
                }
                $left = -$delta;
                foreach ($buckets->sortByDesc('available') as $b) {
                    $n = min((int) $b->available, $left);
                    if ($n > 0) {
                        DB::update('UPDATE inventory SET on_hand = on_hand - ?, updated_at = NOW() WHERE variant_id = ? AND bucket_no = ?', [$n, $variantId, $b->bucket_no]);
                        $left -= $n;
                    }
                }

                return true;
            });
        }

        if (! $ok) {
            throw new DomainException('stock_below_reserved', "variant {$variantId}：調整後的庫存會少於已被預留的數量", 422);
        }

        Cache::forget(CatalogController::CACHE_KEY);   // 前台的商品列表有快取，庫存變了要清掉
    }

    private function settle(int $orderId, string $toStatus, string $inventorySet): void
    {
        $held = DB::table('inventory_reservations')->where('order_id', $orderId)->where('status', 'HELD')->get();

        foreach ($held as $r) {
            // 先搶下這筆預留的狀態（HELD → 目標），搶到的程序才去動庫存 → 不會重複扣
            $won = DB::table('inventory_reservations')
                ->where('id', $r->id)->where('status', 'HELD')
                ->update(['status' => $toStatus, 'updated_at' => now()]);

            if ($won === 1) {
                $bindings = substr_count($inventorySet, '?') === 2 ? [$r->qty, $r->qty] : [$r->qty];
                // 回到預留時的那一桶
                DB::update("UPDATE inventory SET {$inventorySet}, updated_at = NOW() WHERE variant_id = ? AND bucket_no = ?", [...$bindings, $r->variant_id, $r->bucket_no]);
            }
        }
    }
}
