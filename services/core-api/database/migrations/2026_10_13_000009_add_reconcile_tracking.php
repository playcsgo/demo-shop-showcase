<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** 對帳（§6.3 最後防線）：記錄上次對這筆付款發起查詢的時間，避免每次排程都重複查 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('payments', function (Blueprint $table) {
            $table->timestamp('last_reconciled_at')->nullable()->after('succeeded_at');
            $table->unsignedSmallInteger('reconcile_attempts')->default(0)->after('last_reconciled_at');
        });
    }

    public function down(): void
    {
        Schema::table('payments', fn (Blueprint $table) => $table->dropColumn(['last_reconciled_at', 'reconcile_attempts']));
    }
};
