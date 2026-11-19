<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 國家規則：全公司共用，只產生警告，不擋流程，所以每次改動都留紀錄。
 *  - 國家禁令：國家禁某個成分，有列就是禁令，刪除就是解除
 *  - 各國 HS code：覆蓋商品的預設值，只供參考
 * 變更紀錄只新增、不修改；靠同一組鍵對應，刪掉再新增，歷史還接得上
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('product_country_rules', function (Blueprint $table) {
            $table->id();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->char('country_code', 2);
            $table->string('hs_code', 20)->nullable();
            $table->timestamps();
            $table->unique(['product_id', 'country_code']);
        });

        Schema::create('product_country_rule_changes', function (Blueprint $table) {
            $table->id();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->char('country_code', 2);
            $table->foreignId('changed_by_user_id')->constrained('users');
            $table->json('before')->nullable();
            $table->json('after');
            $table->timestamp('created_at')->useCurrent();
            $table->index(['product_id', 'country_code']);
        });

        Schema::create('country_ingredient_bans', function (Blueprint $table) {
            $table->id();
            $table->char('country_code', 2);
            $table->foreignId('ingredient_id')->constrained();
            $table->string('reason')->nullable();
            $table->timestamps();
            $table->unique(['country_code', 'ingredient_id']);
        });

        Schema::create('country_ingredient_ban_changes', function (Blueprint $table) {   // after 是 NULL 代表解除
            $table->id();
            $table->char('country_code', 2);
            $table->foreignId('ingredient_id')->constrained();
            $table->foreignId('changed_by_user_id')->constrained('users');
            $table->json('before')->nullable();
            $table->json('after')->nullable();
            $table->timestamp('created_at')->useCurrent();
            $table->index(['country_code', 'ingredient_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('country_ingredient_ban_changes');
        Schema::dropIfExists('country_ingredient_bans');
        Schema::dropIfExists('product_country_rule_changes');
        Schema::dropIfExists('product_country_rules');
    }
};
