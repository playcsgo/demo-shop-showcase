<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 月結（§5.2）：汪是唯一賣方，喵是供應商；只新增的結算帳本＋每月結算單
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('settlement_statements', function (Blueprint $table) {
            $table->id();
            $table->foreignId('legal_entity_id')->constrained();
            $table->char('period', 7);                            // 2026-10
            $table->enum('status', ['DRAFT', 'CONFIRMED', 'PAID'])->default('DRAFT');
            $table->integer('gross')->default(0);
            $table->integer('refunds')->default(0);
            $table->integer('commission')->default(0);
            $table->integer('fees')->default(0);
            $table->integer('payable')->default(0);               // = 分錄加總
            $table->string('supplier_invoice_no', 20)->nullable();
            $table->foreignId('confirmed_by')->nullable()->constrained('users');
            $table->timestamp('confirmed_at')->nullable();
            $table->timestamps();
            $table->unique(['legal_entity_id', 'period']);
        });

        Schema::create('settlement_entries', function (Blueprint $table) {
            $table->id();
            $table->foreignId('legal_entity_id')->constrained();
            $table->foreignId('brand_id')->constrained();
            $table->enum('type', ['SALE', 'REFUND', 'COMMISSION', 'PAYMENT_FEE', 'ADJUSTMENT']);
            $table->integer('amount');                            // 有正負：應付給供應商為正
            $table->string('ref_type', 30);
            $table->unsignedBigInteger('ref_id');
            $table->timestamp('occurred_at');
            $table->foreignId('statement_id')->nullable()->constrained('settlement_statements'); // 結算前為 null
            $table->string('idempotency_key', 80)->unique();      // sale:{order_item_id}
            $table->timestamp('created_at')->useCurrent();
            $table->index(['legal_entity_id', 'statement_id', 'occurred_at'], 'idx_settlement_unsettled'); // MySQL 索引名稱上限 64 字元
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('settlement_entries');
        Schema::dropIfExists('settlement_statements');
    }
};
