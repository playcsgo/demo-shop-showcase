<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 商品敘述和 SKU 規格（AIC-011）：AI 客服要讀介紹、適用對象、不適用提醒、餵食量，前台商品頁也顯示。
 * 都可以是空的：後台新增的商品不一定寫這些。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('products', function (Blueprint $table) {
            $table->string('slug', 60)->nullable()->unique()->after('brand_id');   // AI 客服和 support 用來指商品
            $table->string('category', 20)->nullable()->after('name');            // 主食罐、保健、用品…
            $table->json('species')->nullable()->after('category');               // ["cat","dog"]
            $table->json('life_stage')->nullable()->after('species');
            $table->json('concerns')->nullable()->after('life_stage');            // ["digestive","kidney"…]
            $table->json('warnings')->nullable()->after('concerns');              // 不適用的情況，一條一句
            $table->text('description_md')->nullable()->after('warnings');        // 介紹、適用情境、成分、注意事項
            $table->json('feeding')->nullable()->after('description_md');         // 餵食量
        });

        Schema::table('product_variants', function (Blueprint $table) {
            $table->string('flavor', 30)->nullable()->after('name');
            $table->string('size_label', 30)->nullable()->after('flavor');
            $table->unsignedInteger('net_weight_g')->nullable()->after('size_label');
            $table->json('dimensions_mm')->nullable()->after('net_weight_g');      // [長, 寬, 高]
            $table->unsignedSmallInteger('shelf_life_days')->nullable()->after('dimensions_mm');
            $table->string('storage', 100)->nullable()->after('shelf_life_days');
            $table->string('packaging', 30)->nullable()->after('storage');
        });
    }

    public function down(): void
    {
        Schema::table('product_variants', function (Blueprint $table) {
            $table->dropColumn(['flavor', 'size_label', 'net_weight_g', 'dimensions_mm', 'shelf_life_days', 'storage', 'packaging']);
        });
        Schema::table('products', function (Blueprint $table) {
            $table->dropUnique(['slug']);
            $table->dropColumn(['slug', 'category', 'species', 'life_stage', 'concerns', 'warnings', 'description_md', 'feeding']);
        });
    }
};
