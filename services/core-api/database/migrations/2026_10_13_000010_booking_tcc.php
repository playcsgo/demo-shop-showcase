<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * 預約改成 TCC（§6.4.1、B14）：
 *  - 購物車項目記住醫院的保留（hold）：選時段時就向醫院保留，付錢前就知道有沒有位子
 *  - 付款多了「只授權」：AUTHORIZED（額度圈住）→ SUCCEEDED（請款）或 VOIDED（取消授權，沒有退款）
 *  - 預約狀態：HELD → AUTHORIZED → CONFIRMED；任何一步失敗 → CANCELLED
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('cart_items', function (Blueprint $table) {
            $table->string('hold_id', 64)->nullable()->after('appointment_at');
            $table->dateTime('hold_expires_at')->nullable()->after('hold_id');
        });

        DB::statement("ALTER TABLE payments MODIFY status ENUM('PENDING','AUTHORIZED','SUCCEEDED','VOIDED','FAILED') NOT NULL DEFAULT 'PENDING'");
        Schema::table('payments', function (Blueprint $table) {
            $table->enum('capture_mode', ['auto', 'manual'])->default('auto')->after('status');
            $table->timestamp('authorized_at')->nullable()->after('succeeded_at');
        });

        DB::statement("ALTER TABLE bookings MODIFY status ENUM('HELD','AUTHORIZED','CONFIRMED','CANCELLED') NOT NULL DEFAULT 'HELD'");
        Schema::table('bookings', function (Blueprint $table) {
            $table->string('hold_id', 64)->nullable()->unique()->after('appointment_at');
            $table->dateTime('hold_expires_at')->nullable()->after('hold_id');
            $table->index(['status', 'updated_at']); // 對帳：找卡住的預約
        });
    }

    public function down(): void
    {
        Schema::table('bookings', function (Blueprint $table) {
            $table->dropIndex(['status', 'updated_at']);
            $table->dropColumn(['hold_id', 'hold_expires_at']);
        });
        DB::statement("ALTER TABLE bookings MODIFY status ENUM('REQUESTED','CONFIRMED','FAILED') NOT NULL DEFAULT 'REQUESTED'");
        Schema::table('payments', fn (Blueprint $table) => $table->dropColumn(['capture_mode', 'authorized_at']));
        DB::statement("ALTER TABLE payments MODIFY status ENUM('PENDING','SUCCEEDED','FAILED') NOT NULL DEFAULT 'PENDING'");
        Schema::table('cart_items', fn (Blueprint $table) => $table->dropColumn(['hold_id', 'hold_expires_at']));
    }
};
