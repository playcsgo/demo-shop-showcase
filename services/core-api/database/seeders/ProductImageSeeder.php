<?php

namespace Database\Seeders;

use App\Models\ProductVariant;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * 種子商品的圖片（database/seed-assets/products/<SKU>.png，generate.php 畫的）上傳到 S3，路徑寫進 products.image_path
 * 可以重複跑（K8s 每次 helm upgrade 都會跑）：
 *   - 路徑含檔案內容的 hash：圖沒變 → 路徑一樣、S3 上也有 → 跳過；圖改了 → 新路徑（瀏覽器快取不會拿到舊圖）
 *   - 後台換過圖的商品不動（image_path 不是 products/seed/ 開頭）
 *   - S3 上的檔案不見了（LocalStack 重啟）→ 重新上傳
 */
class ProductImageSeeder extends Seeder
{
    public function run(): void
    {
        $disk = Storage::disk('s3');
        $done = 0;

        foreach (glob(database_path('seed-assets/products/*.png')) as $file) {
            $sku = basename($file, '.png');
            $product = ProductVariant::where('sku', $sku)->first()?->product;
            if (! $product || ($product->image_path && ! str_starts_with($product->image_path, 'products/seed/'))) {
                continue;
            }

            $path = "products/seed/{$sku}-".substr(md5_file($file), 0, 8).'.png';
            try {
                if ($product->image_path === $path && $disk->exists($path)) {
                    continue;
                }
                if (! $disk->put($path, file_get_contents($file), ['ContentType' => 'image/png'])) {
                    throw new \RuntimeException('put 回傳 false');
                }
            } catch (Throwable $e) {
                // 沒有 S3（例如只開了資料庫）也不要讓整個種子資料失敗：商品照樣能賣，前台顯示預設圖
                $this->command?->warn("商品圖片上傳失敗（{$sku}）：{$e->getMessage()}");

                continue;
            }
            $product->update(['image_path' => $path]);
            $done++;
        }

        $this->command?->info("商品圖片：上傳 {$done} 張");
    }
}
