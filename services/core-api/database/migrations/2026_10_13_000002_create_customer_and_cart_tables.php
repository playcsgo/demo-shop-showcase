<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 顧客與伺服器端購物車（§6.2）。後台使用者沿用 Laravel 內建的 users 表。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('customers', function (Blueprint $table) {
            $table->id();
            $table->string('email')->unique();
            $table->string('name');
            $table->string('password');
            $table->string('payment_token_ref')->nullable(); // mock 綁卡 token（訂閱自動扣款用）
            $table->timestamps();
        });

        Schema::create('carts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('customer_id')->unique()->constrained(); // 一個顧客一台購物車
            $table->timestamps();
        });

        Schema::create('cart_items', function (Blueprint $table) {
            $table->id();
            $table->foreignId('cart_id')->constrained()->cascadeOnDelete();
            $table->foreignId('variant_id')->constrained('product_variants');
            $table->enum('fulfillment_type', ['direct', 'warehouse', 'subscription', 'booking']);
            $table->unsignedInteger('qty');
            $table->dateTime('appointment_at')->nullable();  // 預約商品必填
            $table->timestamps();
            $table->unique(['cart_id', 'variant_id', 'fulfillment_type']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cart_items');
        Schema::dropIfExists('carts');
        Schema::dropIfExists('customers');
    }
};
