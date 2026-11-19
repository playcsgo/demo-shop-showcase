<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 訂閱（§5.7）：demo 5 秒一期、預設 12 期
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('subscriptions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('customer_id')->constrained();
            $table->foreignId('variant_id')->constrained('product_variants');
            $table->foreignId('origin_order_id')->constrained('orders'); // 第一期的訂單
            $table->unsignedInteger('qty');
            $table->unsignedInteger('interval_seconds');
            $table->unsignedInteger('total_cycles');
            $table->unsignedInteger('next_cycle_no')->default(2);        // 第 1 期 = 原始訂單
            $table->timestamp('next_run_at');
            $table->enum('status', ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'])->default('ACTIVE');
            $table->unsignedInteger('consecutive_failures')->default(0);
            $table->string('payment_token_ref');
            $table->timestamps();
            $table->index(['status', 'next_run_at']);                   // 排程每秒掃描
        });

        Schema::create('subscription_cycles', function (Blueprint $table) {
            $table->id();
            $table->foreignId('subscription_id')->constrained();
            $table->unsignedInteger('cycle_no');
            $table->foreignId('order_id')->nullable()->constrained();
            $table->enum('status', ['PENDING', 'PAID', 'FAILED'])->default('PENDING');
            $table->unsignedInteger('attempts')->default(0);
            $table->timestamps();
            $table->unique(['subscription_id', 'cycle_no']);            // 同一期只會有一張訂單
        });

        Schema::table('orders', function (Blueprint $table) {
            $table->foreign('subscription_id')->references('id')->on('subscriptions');
        });
    }

    public function down(): void
    {
        Schema::table('orders', fn (Blueprint $table) => $table->dropForeign(['subscription_id']));
        Schema::dropIfExists('subscription_cycles');
        Schema::dropIfExists('subscriptions');
    }
};
