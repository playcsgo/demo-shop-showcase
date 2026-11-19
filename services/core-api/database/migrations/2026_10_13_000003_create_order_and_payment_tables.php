<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * 訂單、明細（快照）、預留庫存、付款、退款（§5.3～§5.5）
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->string('order_no', 20)->unique();
            $table->foreignId('customer_id')->constrained();
            $table->enum('status', [
                'PENDING_PAYMENT', 'PAID', 'FULFILLING', 'COMPLETED',
                'PARTIALLY_REFUNDED', 'REFUNDED', 'PAYMENT_FAILED', 'CANCELLED',
            ])->default('PENDING_PAYMENT');
            $table->unsignedInteger('subtotal');
            $table->unsignedInteger('shipping_fee');
            $table->unsignedInteger('discount')->default(0);
            $table->unsignedInteger('total');
            $table->foreignId('subscription_id')->nullable(); // 訂閱產生的訂單（FK 在訂閱表建立後補）
            $table->string('utm_source', 50)->nullable();
            $table->string('utm_medium', 50)->nullable();
            $table->string('utm_campaign', 100)->nullable();
            $table->uuid('correlation_id');
            $table->timestamp('paid_at')->nullable();
            $table->timestamps();
            $table->index(['status', 'created_at']);           // 對帳排程掃逾時訂單
            $table->index(['customer_id', 'created_at']);      // 會員中心訂單列表
        });

        Schema::create('order_items', function (Blueprint $table) {
            $table->id();
            $table->foreignId('order_id')->constrained();
            $table->foreignId('variant_id')->constrained('product_variants');
            // —— 下單當下的快照：之後商品改名、改價、合約改抽成都不影響這張單 ——
            $table->string('sku', 40);
            $table->string('product_name');
            $table->unsignedInteger('unit_price');
            $table->unsignedInteger('qty');
            $table->unsignedInteger('line_total');
            $table->foreignId('brand_id')->constrained();
            $table->foreignId('legal_entity_id')->constrained();
            $table->unsignedInteger('commission_bps');          // 汪自己的品牌為 0
            $table->enum('shipping_class', ['standard', 'litter', 'bulky', 'service']);
            // —— 交付 ——
            $table->enum('fulfillment_type', ['direct', 'warehouse', 'subscription', 'booking']);
            $table->enum('fulfillment_status', ['PENDING', 'PROCESSING', 'DONE', 'CANCELLED', 'REFUNDED'])->default('PENDING');
            $table->dateTime('appointment_at')->nullable();
            $table->unsignedInteger('refunded_qty')->default(0);
            $table->timestamps();
            $table->index(['brand_id', 'created_at']);          // 品牌報表
        });
        DB::statement('ALTER TABLE order_items ADD CONSTRAINT chk_refunded_qty CHECK (refunded_qty <= qty)');

        Schema::create('inventory_reservations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('order_id')->constrained();
            $table->foreignId('variant_id')->constrained('product_variants');
            $table->unsignedInteger('qty');
            $table->enum('status', ['HELD', 'COMMITTED', 'RELEASED'])->default('HELD');
            $table->timestamp('expires_at');
            $table->timestamps();
            $table->unique(['order_id', 'variant_id']);
        });

        Schema::create('payments', function (Blueprint $table) {
            $table->id();
            $table->foreignId('order_id')->unique()->constrained(); // 一張訂單一筆付款
            $table->foreignId('merchant_account_id')->constrained();
            $table->unsignedInteger('amount');
            $table->unsignedInteger('refunded_amount')->default(0);
            $table->enum('status', ['PENDING', 'SUCCEEDED', 'FAILED'])->default('PENDING');
            $table->string('provider_txn_id', 64)->nullable()->unique();
            $table->string('idempotency_key', 80)->unique();
            $table->timestamp('succeeded_at')->nullable();
            $table->timestamps();
        });
        // 部分退款加總不能超過付款金額
        DB::statement('ALTER TABLE payments ADD CONSTRAINT chk_refund_not_exceed CHECK (refunded_amount <= amount)');

        Schema::create('refunds', function (Blueprint $table) {
            $table->id();
            $table->foreignId('payment_id')->constrained();
            $table->foreignId('order_id')->constrained();
            $table->unsignedInteger('amount');
            $table->string('reason', 50);                        // customer_cancel／booking_failed／…
            $table->enum('status', ['PENDING', 'SUCCEEDED', 'FAILED'])->default('PENDING');
            $table->string('provider_refund_id', 64)->nullable()->unique();
            $table->string('idempotency_key', 80)->unique();
            $table->timestamp('succeeded_at')->nullable();
            $table->timestamps();
        });

        Schema::create('refund_items', function (Blueprint $table) {
            $table->id();
            $table->foreignId('refund_id')->constrained();
            $table->foreignId('order_item_id')->constrained();
            $table->unsignedInteger('qty');
            $table->unsignedInteger('amount');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('refund_items');
        Schema::dropIfExists('refunds');
        Schema::dropIfExists('payments');
        Schema::dropIfExists('inventory_reservations');
        Schema::dropIfExists('order_items');
        Schema::dropIfExists('orders');
    }
};
