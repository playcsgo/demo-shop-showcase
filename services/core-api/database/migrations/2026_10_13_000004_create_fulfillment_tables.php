<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 交付：寄倉帳本、提領、包裹（依 shipping_class 拆）、物流事件、預約（§5.5、§5.6）
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('warehouse_accounts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('customer_id')->constrained();
            $table->foreignId('variant_id')->constrained('product_variants');
            $table->integer('balance')->default(0);           // 帳本加總的快取，和帳本在同一交易更新
            $table->timestamps();
            $table->unique(['customer_id', 'variant_id']);
        });
        \Illuminate\Support\Facades\DB::statement('ALTER TABLE warehouse_accounts ADD CONSTRAINT chk_balance_non_negative CHECK (balance >= 0)');

        // 只新增、不修改：每一筆增減都有來源，可稽核、可對帳
        Schema::create('warehouse_ledger', function (Blueprint $table) {
            $table->id();
            $table->foreignId('account_id')->constrained('warehouse_accounts');
            $table->integer('delta');                          // ＋入帳／−提領／−退款
            $table->enum('reason', ['DEPOSIT', 'WITHDRAW', 'REFUND']);
            $table->string('ref_type', 30);
            $table->unsignedBigInteger('ref_id');
            $table->string('idempotency_key', 80)->unique();   // 同一件事只記一次
            $table->timestamp('created_at')->useCurrent();
        });

        Schema::create('withdrawals', function (Blueprint $table) {
            $table->id();
            $table->foreignId('account_id')->constrained('warehouse_accounts');
            $table->unsignedInteger('qty');
            $table->enum('status', ['REQUESTED', 'SHIPPING', 'DONE'])->default('REQUESTED');
            $table->string('idempotency_key', 80)->unique();   // 客戶重按「提領」不會扣兩次
            $table->timestamps();
        });

        Schema::create('shipments', function (Blueprint $table) {
            $table->id();
            $table->foreignId('order_id')->nullable()->constrained();
            $table->foreignId('withdrawal_id')->nullable()->unique()->constrained();
            $table->unsignedSmallInteger('seq')->default(1);   // 包裹 1、2、3
            $table->enum('shipping_class', ['standard', 'litter', 'bulky']);
            $table->string('carrier', 30);                     // home_delivery／bulky_freight
            $table->string('tracking_no', 40)->nullable()->unique();
            $table->enum('status', ['PENDING', 'REQUESTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED'])->default('PENDING');
            $table->timestamp('last_event_at')->nullable();    // 晚到的舊事件不能覆蓋新狀態
            $table->unsignedInteger('shipping_fee')->default(0);
            $table->timestamps();
            $table->unique(['order_id', 'seq']);
        });

        Schema::create('shipment_items', function (Blueprint $table) {
            $table->id();
            $table->foreignId('shipment_id')->constrained();
            $table->foreignId('order_item_id')->nullable()->constrained(); // 提領出貨沒有訂單明細
            $table->foreignId('variant_id')->constrained('product_variants');
            $table->unsignedInteger('qty');
        });

        Schema::create('shipment_events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('shipment_id')->constrained();
            $table->enum('status', ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED']);
            $table->timestamp('occurred_at');
            $table->string('provider_event_id', 64)->unique(); // 重複 callback 只記一次
            $table->timestamp('created_at')->useCurrent();
            $table->index(['shipment_id', 'occurred_at']);
        });

        // 服務類（健康檢查）：沒有任何物流欄位
        Schema::create('bookings', function (Blueprint $table) {
            $table->id();
            $table->foreignId('order_item_id')->unique()->constrained();
            $table->string('order_no', 20);
            $table->string('service_type', 30);
            $table->dateTime('appointment_at');
            $table->enum('status', ['REQUESTED', 'CONFIRMED', 'FAILED'])->default('REQUESTED');
            $table->string('provider_booking_id', 64)->nullable()->unique();
            $table->string('failure_reason')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('bookings');
        Schema::dropIfExists('shipment_events');
        Schema::dropIfExists('shipment_items');
        Schema::dropIfExists('shipments');
        Schema::dropIfExists('withdrawals');
        Schema::dropIfExists('warehouse_ledger');
        Schema::dropIfExists('warehouse_accounts');
    }
};
