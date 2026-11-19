<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 批次和訂單（SIL-004）
 *   批次＝一次送出，審核和付款都在這層；訂單＝批次裡一個 shop 一張，生產和出貨在這層
 *   價格在送出時算好存下來：合約之後改版，不影響已送出的單
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('distributor_batches', function (Blueprint $table) {
            $table->id();
            $table->string('batch_no', 20)->unique();
            $table->foreignId('distributor_id')->constrained();
            $table->foreignId('contract_id')->constrained('distributor_contracts');
            $table->foreignId('submitted_by_user_id')->constrained('distributor_users');
            $table->string('request_key', 80);   // Idempotency-Key：長度和 IdempotencyStore 允許的一樣
            $table->string('order_type', 20);    // stock／early_bird
            $table->string('status', 30);
            $table->char('currency', 3);
            $table->unsignedBigInteger('total_minor');
            $table->unsignedSmallInteger('prepay_bps');
            $table->unsignedBigInteger('prepay_minor');
            $table->unsignedInteger('revision')->default(1);
            $table->timestamp('submitted_at');
            $table->date('anticipated_response_date');
            $table->json('warnings');
            $table->json('moq_results');
            $table->timestamps();
            $table->unique(['distributor_id', 'request_key']);
            $table->index(['status', 'anticipated_response_date']);
        });

        Schema::create('distributor_orders', function (Blueprint $table) {
            $table->id();
            $table->string('order_no', 20)->unique();
            $table->foreignId('batch_id')->constrained('distributor_batches');
            $table->foreignId('shop_id')->constrained('distributor_shops');
            $table->string('status', 30)->default('PENDING');
            $table->date('requested_ship_date')->nullable();   // 早鳥才有
            $table->unsignedBigInteger('subtotal_minor');
            $table->timestamps();
            $table->unique(['batch_id', 'shop_id']);
        });

        Schema::create('distributor_order_items', function (Blueprint $table) {
            $table->id();
            $table->foreignId('order_id')->constrained('distributor_orders')->cascadeOnDelete();
            $table->foreignId('product_id')->constrained('products');
            $table->unsignedInteger('qty_cases');
            $table->unsignedInteger('case_size');
            $table->unsignedInteger('qty_units');
            $table->unsignedInteger('unit_price_minor');
            $table->unsignedBigInteger('amount_minor');
            $table->string('hs_code', 20)->nullable();   // 送出當時的值，之後改碼不影響
            $table->timestamps();
            $table->unique(['order_id', 'product_id']);
        });

        Schema::create('distributor_batch_revisions', function (Blueprint $table) {   // 只新增，每次送出一筆
            $table->id();
            $table->foreignId('batch_id')->constrained('distributor_batches');
            $table->unsignedInteger('revision');
            $table->json('snapshot');
            $table->foreignId('submitted_by_user_id')->constrained('distributor_users');
            $table->timestamp('submitted_at');
            $table->text('reject_reason')->nullable();
            $table->foreignId('rejected_by_user_id')->nullable()->constrained('users');
            $table->timestamp('rejected_at')->nullable();
            $table->unique(['batch_id', 'revision']);
        });

        Schema::create('distributor_order_events', function (Blueprint $table) {      // 只新增，時間軸
            $table->id();
            $table->foreignId('batch_id')->constrained('distributor_batches');
            // 重送時拿掉的 shop，訂單會刪除；事件還屬於這一批，時間軸不會斷
            $table->foreignId('order_id')->nullable()->constrained('distributor_orders')->nullOnDelete();
            $table->string('type', 40);
            $table->string('actor_type', 20);
            $table->unsignedBigInteger('actor_id')->nullable();
            $table->text('note')->nullable();
            $table->timestamp('occurred_at');
            $table->index(['batch_id', 'occurred_at']);
        });

        Schema::create('inventory_reservations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('distributor_order_id')->constrained('distributor_orders');
            $table->foreignId('product_id')->constrained();
            $table->unsignedInteger('qty');
            $table->string('status', 20)->default('HELD');     // ReservationStatus
            $table->timestamps();
            $table->unique(['distributor_order_id', 'product_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('inventory_reservations');
        Schema::dropIfExists('distributor_order_events');
        Schema::dropIfExists('distributor_batch_revisions');
        Schema::dropIfExists('distributor_order_items');
        Schema::dropIfExists('distributor_orders');
        Schema::dropIfExists('distributor_batches');
    }
};
