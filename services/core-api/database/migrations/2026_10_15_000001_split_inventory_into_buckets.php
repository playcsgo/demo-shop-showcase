<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * 庫存分桶：熱門商品的庫存拆成好幾列，同時下單的人分散去鎖不同列，不用全部排隊等同一列。
 *
 * 壓測發現的瓶頸：每賣一件，同一列庫存要被鎖兩次（結帳預留、付款成功實扣），
 * 熱門商品所有人排隊等這一列，Pod 加到 8 個也沒用。
 *
 *   inventory：一個商品原本一列，改成「一個商品 N 列（桶）」，主鍵 (variant_id, bucket_no)；
 *              現有的資料就是桶 0，一般商品永遠只有桶 0（跟原本一樣）
 *              每一桶各自有 CHECK（reserved >= 0 AND on_hand >= reserved）：任何一桶都不會超賣
 *   product_variants.bucket_target：想要幾桶（宣告式：後台、sandbox、自動偵測只改這個數字，
 *              core-scheduler 的 inventory:buckets 負責把實際的桶數收斂過去）
 *   inventory_reservations.bucket_no：從哪一桶預留的（實扣、釋放回到同一桶）
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE inventory
            ADD COLUMN bucket_no SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER variant_id,
            DROP PRIMARY KEY, ADD PRIMARY KEY (variant_id, bucket_no)');

        Schema::table('product_variants', function (Blueprint $table) {
            $table->unsignedSmallInteger('bucket_target')->default(1)->after('price');
            $table->enum('hot_mode', ['off', 'manual', 'auto'])->default('off')->after('bucket_target');   // 誰開的熱賣模式
            $table->timestamp('hot_since')->nullable()->after('hot_mode');
        });

        Schema::table('inventory_reservations', function (Blueprint $table) {
            $table->unsignedSmallInteger('bucket_no')->default(0)->after('variant_id');
            // 快賣完時，一個商品可能從兩桶各扣一部分 → 同一張訂單同一個商品會有多筆預留（一桶一筆）
            // 先加新的再刪舊的：order_id 的外鍵需要一個 order_id 開頭的索引
            $table->unique(['order_id', 'variant_id', 'bucket_no']);
            $table->dropUnique(['order_id', 'variant_id']);
        });
    }

    public function down(): void
    {
        // 併回一桶再改回原本的主鍵
        DB::statement('UPDATE inventory i JOIN (SELECT variant_id, SUM(on_hand) oh, SUM(reserved) rs FROM inventory GROUP BY variant_id) t
            ON t.variant_id = i.variant_id SET i.on_hand = t.oh, i.reserved = t.rs WHERE i.bucket_no = 0');
        DB::table('inventory')->where('bucket_no', '>', 0)->delete();
        DB::statement('ALTER TABLE inventory DROP PRIMARY KEY, DROP COLUMN bucket_no, ADD PRIMARY KEY (variant_id)');

        Schema::table('inventory_reservations', function (Blueprint $table) {
            $table->unique(['order_id', 'variant_id']);
            $table->dropUnique(['order_id', 'variant_id', 'bucket_no']);
            $table->dropColumn('bucket_no');
        });
        Schema::table('product_variants', fn (Blueprint $table) => $table->dropColumn(['bucket_target', 'hot_mode', 'hot_since']));
    }
};
