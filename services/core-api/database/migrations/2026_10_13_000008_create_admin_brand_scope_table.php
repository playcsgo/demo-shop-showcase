<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 後台權限範圍（§8.1 ABAC）：後台使用者可管理哪些品牌；finance 可看哪些法人
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('brand_user', function (Blueprint $table) {
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('brand_id')->constrained()->cascadeOnDelete();
            $table->primary(['user_id', 'brand_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('brand_user');
    }
};
