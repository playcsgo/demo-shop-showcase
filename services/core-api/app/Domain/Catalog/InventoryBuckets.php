<?php

namespace App\Domain\Catalog;

use App\Http\Controllers\Api\CatalogController;
use App\Models\ProductVariant;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * 庫存分桶的控制器（和 K8s 的 controller 同一個想法：宣告想要的狀態，由一個程序負責收斂過去）
 *
 *   想要幾桶：product_variants.bucket_target（後台的熱賣模式、sandbox、壓測指令都只改這個數字，不用重新部署）
 *   實際幾桶：inventory 的列數
 *   收斂：core-scheduler 每 5 秒跑一次 converge()（php artisan inventory:buckets），只有一個程序在搬，不會互相搶
 *     1. 拆：桶不夠 → 新增空桶（每桶至少 min_per_bucket 件可賣才拆）
 *     2. 併：桶號 ≥ 想要的桶數 → 可賣的搬回桶 0；預留都處理完（on_hand、reserved 都是 0）就刪掉
 *     3. 平衡：某一桶的可賣數量低於平均的一半 → 從最多的那桶搬過去；總共剩不多時就不搬了（最後幾件搶一下就賣完）
 *
 * 不擋客人：搬庫存要鎖兩桶，用 SKIP LOCKED，客人正在用就放棄這一次、下一輪再來（客人挑桶也是 SKIP LOCKED，會跳過正在搬的桶）。
 * 不會算錯：每次搬都是「一桶減、一桶加」在同一個交易，減的那一桶有條件（可賣的夠才減）；預留記著自己的桶號，拆／併不影響已經下的單。
 */
class InventoryBuckets
{
    /** 設定想要幾桶（宣告），實際的拆／併交給 converge()。hot_mode：manual（後台、sandbox）、auto（自動偵測）、off */
    public function setTarget(ProductVariant $variant, int $buckets, string $mode = 'manual'): void
    {
        $buckets = max(1, $buckets);
        $variant->forceFill([
            'bucket_target' => $buckets,
            'hot_mode' => $buckets > 1 ? $mode : 'off',
            'hot_since' => $buckets > 1 ? ($variant->bucket_target > 1 ? $variant->hot_since : now()) : null,
        ])->save();
    }

    /** 熱賣模式開關（後台用）：開 → config 的桶數；關 → 1 桶 */
    public function setHot(ProductVariant $variant, bool $on): void
    {
        if ($on !== ($variant->bucket_target > 1)) {
            $this->setTarget($variant, $on ? (int) config('shop.inventory.hot_buckets') : 1);
        }
    }

    /**
     * 所有需要處理的商品各收斂一次（想要多桶的，或實際還有多桶的）
     *
     * @return array{changed: int, yielded: int} changed：搬了／新增／刪除幾次；yielded：客人正在用、這一輪讓路幾次
     */
    public function run(): array
    {
        $ids = DB::table('product_variants')->where('bucket_target', '>', 1)->pluck('id')
            ->merge(DB::table('inventory')->where('bucket_no', '>', 0)->distinct()->pluck('variant_id'))
            ->unique();

        $total = ['changed' => 0, 'yielded' => 0];
        foreach ($ids as $id) {
            $r = $this->converge((int) $id);
            $total['changed'] += $r['changed'];
            $total['yielded'] += $r['yielded'];
        }

        return $total;
    }

    /** @return array{changed: int, yielded: int} */
    public function converge(int $variantId): array
    {
        $target = max(1, (int) DB::table('product_variants')->where('id', $variantId)->value('bucket_target'));
        $minPerBucket = max(1, (int) config('shop.inventory.min_per_bucket'));
        $changed = 0;
        $yielded = 0;

        // 不上鎖地讀：只是決定要做什麼，真正搬的時候會上鎖再檢查一次
        $buckets = $this->read($variantId);
        if ($buckets === []) {
            return ['changed' => 0, 'yielded' => 0];   // 服務類商品沒有庫存
        }

        // 1. 拆
        $available = array_sum($buckets);
        $want = min($target, max(1, intdiv($available, $minPerBucket)));
        $missing = array_diff(range(0, $want - 1), array_keys($buckets));
        if ($missing) {
            $now = now();
            DB::table('inventory')->insertOrIgnore(array_map(fn ($b) => [
                'variant_id' => $variantId, 'bucket_no' => $b, 'on_hand' => 0, 'reserved' => 0, 'created_at' => $now, 'updated_at' => $now,
            ], array_values($missing)));
            Log::info('inventory buckets split', ['variant_id' => $variantId, 'from' => count($buckets), 'to' => count($buckets) + count($missing), 'target' => $target]);
            $changed += count($missing);
            $buckets = $this->read($variantId);
        }

        // 2. 併
        foreach (array_keys($buckets) as $b) {
            if ($b < $target || $b === 0) {
                continue;
            }
            if ($buckets[$b] > 0) {
                $this->move($variantId, $b, 0, $buckets[$b]) ? $changed++ : $yielded++;
            }
            // 條件式刪除：預留都處理完（on_hand、reserved 都是 0）才刪；還有沒結案的預留就等下一輪
            if (DB::table('inventory')->where('variant_id', $variantId)->where('bucket_no', $b)->where('on_hand', 0)->where('reserved', 0)->delete()) {
                Log::info('inventory bucket merged', ['variant_id' => $variantId, 'bucket_no' => $b]);
                $changed++;
            }
        }

        // 3. 平衡（只看桶號 < 想要的桶數的桶）
        $active = array_filter($this->read($variantId), fn ($b) => $b < $target, ARRAY_FILTER_USE_KEY);
        $n = count($active);
        if ($n > 1 && array_sum($active) >= $n * 2) {
            $avg = intdiv(array_sum($active), $n);
            for ($i = 0; $i < $n; $i++) {
                $from = array_keys($active, max($active))[0];
                $to = array_keys($active, min($active))[0];
                if ($active[$to] >= intdiv($avg, 2)) {
                    break;   // 差不多平均就不動：不要一直鎖桶
                }
                $qty = min($active[$from] - $avg, $avg - $active[$to]);
                if ($qty <= 0) {
                    break;
                }
                if (! $this->move($variantId, $from, $to, $qty)) {
                    $yielded++;
                    break;   // 客人正在用：這一輪讓路，5 秒後再來
                }
                $active[$from] -= $qty;
                $active[$to] += $qty;
                $changed++;
            }
        }

        if ($changed > 0) {
            Cache::forget(CatalogController::CACHE_KEY);
        }

        return ['changed' => $changed, 'yielded' => $yielded];
    }

    /** @return array<int, int> bucket_no => 可賣數量 */
    private function read(int $variantId): array
    {
        return DB::table('inventory')->where('variant_id', $variantId)->orderBy('bucket_no')
            ->selectRaw('bucket_no, on_hand - reserved AS available')->pluck('available', 'bucket_no')->map(fn ($v) => (int) $v)->all();
    }

    /**
     * 從一桶搬 qty 件可賣的庫存到另一桶。客人正在用其中一桶 → 不等，回傳 false（下一輪再來）
     */
    private function move(int $variantId, int $from, int $to, int $qty): bool
    {
        return DB::transaction(function () use ($variantId, $from, $to, $qty) {
            // 照桶號順序鎖兩桶；SKIP LOCKED：被客人鎖住的桶直接跳過 → 沒拿到兩桶就放棄
            $locked = DB::select('SELECT bucket_no FROM inventory WHERE variant_id = ? AND bucket_no IN (?, ?) ORDER BY bucket_no FOR UPDATE SKIP LOCKED', [$variantId, $from, $to]);
            if (count($locked) < 2) {
                return false;
            }
            $took = DB::update('UPDATE inventory SET on_hand = on_hand - ?, updated_at = NOW() WHERE variant_id = ? AND bucket_no = ? AND on_hand - reserved >= ?', [$qty, $variantId, $from, $qty]);
            if ($took !== 1) {
                return false;   // 剛剛被客人買走了，不夠搬
            }
            DB::update('UPDATE inventory SET on_hand = on_hand + ?, updated_at = NOW() WHERE variant_id = ? AND bucket_no = ?', [$qty, $variantId, $to]);

            return true;
        });
    }
}
