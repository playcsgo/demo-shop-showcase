<?php

namespace App\Console\Commands;

use App\Domain\Catalog\InventoryBuckets;
use App\Models\Customer;
use App\Models\ProductVariant;
use Database\Seeders\ProductImageSeeder;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * sandbox 情境的測試資料（data.env）：在種子資料之上調整
 *   php artisan sandbox:data --customers=200 --stock=1000000 --sku=DCS-DH-M:3
 *   --customers：顧客 shopper01～shopperNN（密碼都是 0204），k6 的第 N 個虛擬使用者用 shopperN
 *   --stock：所有商品的庫存（預設拉到夠所有測試用；「庫存不足」是獨立的情境）
 *   --sku：個別商品的庫存，可以重複
 *   --buckets：所有實體商品的庫存分幾桶（熱賣模式，預設 1＝不分）；--bucket=SKU:桶數 個別設定，可以重複
 *              庫存先放回一桶、設好數量，再依桶數拆開（馬上拆好，不等排程）；跑到一半要改用 php artisan inventory:buckets
 *   --seed-if-empty：資料庫還是空的才灌種子資料＋套用上面的設定；已經有資料就只補商品圖片（K8s 每次 helm install／upgrade 都會跑）
 * 商品圖片（ProductImageSeeder）每次都會檢查：加圖片功能之前灌的資料庫也會補上；已經上傳過就跳過
 */
class SandboxData extends Command
{
    protected $signature = 'sandbox:data {--customers=30} {--stock=1000000} {--sku=* : SKU:數量} {--buckets=1 : 所有商品分幾桶} {--bucket=* : SKU:桶數} {--seed-if-empty}';

    protected $description = '依情境設定測試資料（顧客數、庫存）';

    public function handle(InventoryBuckets $buckets): int
    {
        if ($this->option('seed-if-empty')) {
            if (DB::table('customers')->exists()) {
                $this->seedImages();
                $this->info('已經有資料，不重灌');

                return self::SUCCESS;
            }
            $this->call('db:seed', ['--force' => true]);   // 包含商品圖片
        } else {
            $this->seedImages();
        }

        $want = (int) $this->option('customers');
        $have = Customer::where('email', 'like', 'shopper%@example.test')->count();
        if ($want > $have) {
            $hash = bcrypt('0204');   // 只算一次：bcrypt 很慢，幾百個顧客各算一次要好幾十秒
            $now = now();
            $rows = [];
            foreach (range($have + 1, $want) as $i) {
                $n = sprintf('%02d', $i);
                $rows[] = ['email' => "shopper{$n}@example.test", 'name' => "Shopper {$n}", 'password' => $hash, 'payment_token_ref' => "tok_mock_{$n}", 'created_at' => $now, 'updated_at' => $now];
            }
            foreach (array_chunk($rows, 500) as $chunk) {
                DB::table('customers')->insert($chunk);
            }
        }

        // 庫存先併回一桶（桶 0）再設定數量：上一輪分了幾桶都不影響這一輪
        DB::table('inventory')->where('bucket_no', '>', 0)->delete();
        DB::table('inventory')->update(['on_hand' => (int) $this->option('stock'), 'reserved' => 0]);
        foreach ($this->option('sku') as $pair) {
            [$sku, $qty] = explode(':', $pair) + [1 => null];
            $variantId = DB::table('product_variants')->where('sku', $sku)->value('id');
            if (! $variantId || $qty === null) {
                $this->error("無法設定庫存：{$pair}");

                return self::FAILURE;
            }
            DB::table('inventory')->where('variant_id', $variantId)->update(['on_hand' => (int) $qty]);
        }

        // 分桶：先設定想要幾桶，再馬上收斂（拆好、平均分配）
        $targets = ProductVariant::where('shipping_class', '!=', 'service')->pluck('id', 'sku')
            ->map(fn () => max(1, (int) $this->option('buckets')))->all();
        foreach ($this->option('bucket') as $pair) {
            [$sku, $n] = explode(':', $pair) + [1 => null];
            if (! array_key_exists($sku, $targets) || $n === null) {
                $this->error("無法設定桶數：{$pair}");

                return self::FAILURE;
            }
            $targets[$sku] = max(1, (int) $n);
        }
        foreach (ProductVariant::whereIn('sku', array_keys($targets))->get() as $v) {
            $buckets->setTarget($v, $targets[$v->sku]);
            $buckets->converge($v->id);
        }

        $this->line(json_encode([
            'customers' => Customer::where('email', 'like', 'shopper%@example.test')->count(),
            'stock' => DB::table('inventory as i')->join('product_variants as v', 'v.id', '=', 'i.variant_id')
                ->groupBy('v.sku')->selectRaw('v.sku, SUM(i.on_hand) AS on_hand')->pluck('on_hand', 'sku')->map(fn ($n) => (int) $n),
            'buckets' => DB::table('inventory as i')->join('product_variants as v', 'v.id', '=', 'i.variant_id')
                ->groupBy('v.sku')->havingRaw('COUNT(*) > 1')->selectRaw('v.sku, COUNT(*) AS n')->pluck('n', 'sku'),
        ], JSON_UNESCAPED_UNICODE));

        return self::SUCCESS;
    }

    private function seedImages(): void
    {
        $this->call('db:seed', ['--class' => ProductImageSeeder::class, '--force' => true]);
    }
}
