<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 可靠度（§5.8）：outbox（與業務資料同交易寫入）、inbox（消費端去重）、API 冪等
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('outbox_messages', function (Blueprint $table) {
            $table->id();
            $table->uuid('event_id')->unique();
            $table->string('type', 60);
            $table->string('queue', 40);
            $table->json('payload');                              // 完整事件信封
            $table->uuid('correlation_id');
            $table->enum('status', ['PENDING', 'SENT'])->default('PENDING');
            $table->unsignedInteger('attempts')->default(0);
            $table->timestamp('available_at')->useCurrent();
            $table->timestamp('sent_at')->nullable();
            $table->timestamps();
            $table->index(['status', 'available_at']);            // 發送程序掃描
        });

        Schema::create('inbox_messages', function (Blueprint $table) {
            $table->id();
            $table->uuid('event_id')->unique();                   // 同一個事件只處理一次
            $table->string('type', 60);
            $table->timestamp('processed_at')->useCurrent();
        });

        Schema::create('idempotency_keys', function (Blueprint $table) {
            $table->id();
            $table->string('key', 80);
            $table->unsignedBigInteger('customer_id');
            $table->char('request_hash', 64);
            $table->unsignedSmallInteger('response_code')->nullable(); // null = 處理中
            $table->json('response_body')->nullable();
            $table->timestamps();
            $table->unique(['customer_id', 'key']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('idempotency_keys');
        Schema::dropIfExists('inbox_messages');
        Schema::dropIfExists('outbox_messages');
    }
};
