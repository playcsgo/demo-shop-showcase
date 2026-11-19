<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 經銷商（SIL-001）：付款主體 → 多個帳號、多個收貨地點（shop）
 * 帳號獨立成表，不共用員工的 users。刪經銷商時連帶刪除帳號、shop、合約；批次是 RESTRICT，有訂單就刪不掉
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('distributors', function (Blueprint $table) {
            $table->id();
            $table->string('code', 20)->unique();
            $table->string('name');
            $table->char('currency', 3);
            $table->foreignId('sales_user_id')->constrained('users');   // 負責的業務（已有索引：外鍵會自動建）
            $table->string('status', 20)->default('active');
            $table->timestamps();
        });

        Schema::create('distributor_users', function (Blueprint $table) {
            $table->id();
            $table->foreignId('distributor_id')->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->string('email')->unique();
            $table->string('password');
            $table->string('role', 20)->default('buyer');
            $table->timestamps();
        });

        Schema::create('distributor_shops', function (Blueprint $table) {
            $table->id();
            $table->foreignId('distributor_id')->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->char('country_code', 2);
            $table->string('city');
            $table->string('address');
            $table->string('destination_port', 100)->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('distributor_shops');
        Schema::dropIfExists('distributor_users');
        Schema::dropIfExists('distributors');
    }
};
