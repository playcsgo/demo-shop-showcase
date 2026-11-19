<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * 經銷商自己的商品和庫存，和商店完全分開：B2C 賣出商品不影響這裡的數字。
 * 不參與壓力測試，所以每個商品一列庫存，不分桶
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('products', function (Blueprint $table) {
            $table->id();
            $table->string('sku', 40)->unique();
            $table->string('name');                                    // 中文商品名稱
            $table->string('temperature_class', 20)->default('ambient');
            $table->string('hs_code', 20)->nullable();                 // 預設值，國家可覆蓋；只供參考，最終以貨代為準
            $table->boolean('no_ingredients')->default(false);         // 非食品：沒有成分要檢查，不提醒「未填成分」
            $table->timestamps();
        });

        Schema::create('inventory', function (Blueprint $table) {
            $table->foreignId('product_id')->primary()->constrained()->cascadeOnDelete();
            $table->unsignedInteger('on_hand')->default(0);
            $table->unsignedInteger('reserved')->default(0);
            $table->timestamps();
        });
        DB::statement('ALTER TABLE inventory ADD CONSTRAINT chk_inventory_reserved CHECK (reserved <= on_hand)');

        Schema::create('ingredients', function (Blueprint $table) {
            $table->id();
            $table->string('name', 50)->unique();
            $table->timestamps();
        });

        Schema::create('ingredient_product', function (Blueprint $table) {
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->foreignId('ingredient_id')->constrained();
            $table->primary(['product_id', 'ingredient_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ingredient_product');
        Schema::dropIfExists('ingredients');
        Schema::dropIfExists('inventory');
        Schema::dropIfExists('products');
    }
};
