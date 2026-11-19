<?php

namespace App\Console\Commands;

use App\Domain\Catalog\InventoryBuckets;
use App\Models\ProductVariant;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * 庫存分桶（InventoryBuckets）
 *   php artisan inventory:buckets                 收斂一次（core-scheduler 每 5 秒跑）：依想要的桶數拆／併、平衡
 *   php artisan inventory:buckets 8 DCS-CAN-DUCK-80      設定想要幾桶（不給 SKU＝所有實體商品）；sandbox、壓測用，跑到一半也可以改
 *   php artisan inventory:buckets 8 --now         設定之後馬上收斂（不等排程），印出每個商品現在幾桶
 *   php artisan inventory:buckets --status        只看現在每個商品幾桶
 */
class InventoryBucketsCommand extends Command
{
    protected $signature = 'inventory:buckets {target? : 想要幾桶（1＝不分）} {sku?* : 只設定這些商品} {--now : 設定後馬上收斂} {--status : 印出每個商品的桶數}';

    protected $description = '庫存分桶：設定想要幾桶，或收斂一次';

    public function handle(InventoryBuckets $buckets): int
    {
        if ($this->option('status')) {
            return $this->status();
        }

        if ($this->argument('target') !== null) {
            $variants = ProductVariant::where('shipping_class', '!=', 'service')
                ->when($this->argument('sku'), fn ($q, $skus) => $q->whereIn('sku', $skus))->get();
            foreach ($variants as $v) {
                $buckets->setTarget($v, (int) $this->argument('target'));
            }
            $this->info("想要的桶數 → {$this->argument('target')}：".$variants->pluck('sku')->implode('、'));
            if (! $this->option('now')) {
                return self::SUCCESS;   // core-scheduler 5 秒內會收斂
            }
        }

        // 一次可能搬不完（客人正在用的桶會讓路）：--now 時多跑幾輪
        $rounds = $this->option('now') ? 10 : 1;
        for ($i = 0; $i < $rounds; $i++) {
            $r = $buckets->run();
            if ($r['changed'] > 0 || $r['yielded'] > 0) {
                $this->line("inventory buckets: changed={$r['changed']} yielded={$r['yielded']}");
            }
            if ($r['changed'] === 0 && $r['yielded'] === 0) {
                break;
            }
        }

        return $this->option('now') ? $this->status() : self::SUCCESS;
    }

    private function status(): int
    {
        $rows = DB::table('product_variants as v')->join('inventory as i', 'i.variant_id', '=', 'v.id')
            ->groupBy('v.sku', 'v.bucket_target', 'v.hot_mode')->orderBy('v.sku')
            ->selectRaw('v.sku, v.bucket_target, v.hot_mode, COUNT(*) AS buckets, SUM(i.on_hand - i.reserved) AS available')->get();
        $this->table(['SKU', '想要', '實際', '可賣', '熱賣模式'], $rows->map(fn ($r) => [$r->sku, $r->bucket_target, $r->buckets, $r->available, $r->hot_mode])->all());

        return self::SUCCESS;
    }
}
