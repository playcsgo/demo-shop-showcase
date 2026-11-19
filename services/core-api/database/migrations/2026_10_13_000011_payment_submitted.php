<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * 付款多一個狀態 SUBMITTED：hub 已經把扣款送給金流、金流也收下了，只是結果（webhook）還沒來。
 * 用來分辨「還在佇列裡排隊」（PENDING：問金流也是查無此筆，不要問）和「真的在等結果」（SUBMITTED：webhook 遺失時要問）。
 * next_reconcile_at：下一次可以對帳／重送的時間，每問一次就往後推（指數退避）——壓測時積壓會讓對帳查詢自己放大
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement("ALTER TABLE payments MODIFY status ENUM('PENDING','SUBMITTED','AUTHORIZED','SUCCEEDED','VOIDED','FAILED') NOT NULL DEFAULT 'PENDING'");
        Schema::table('payments', function (Blueprint $table) {
            $table->timestamp('submitted_at')->nullable()->after('authorized_at');
            $table->timestamp('next_reconcile_at')->nullable()->after('last_reconciled_at');
            $table->index(['status', 'next_reconcile_at']);
        });
    }

    public function down(): void
    {
        Schema::table('payments', function (Blueprint $table) {
            $table->dropIndex(['status', 'next_reconcile_at']);
            $table->dropColumn(['submitted_at', 'next_reconcile_at']);
        });
        DB::statement("ALTER TABLE payments MODIFY status ENUM('PENDING','AUTHORIZED','SUCCEEDED','VOIDED','FAILED') NOT NULL DEFAULT 'PENDING'");
    }
};
