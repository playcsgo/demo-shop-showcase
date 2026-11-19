<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// 誰發起的退款、超過期限仍要退的原因（AIC-016）：AI 客服的提案、後台的例外退款都要查得到
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('refunds', function (Blueprint $table) {
            $table->string('requested_by', 50)->nullable()->after('reason');   // support_staff:3、admin:1、load_test
            $table->string('override_reason', 200)->nullable()->after('requested_by');
        });
    }

    public function down(): void
    {
        Schema::table('refunds', function (Blueprint $table) {
            $table->dropColumn(['requested_by', 'override_reason']);
        });
    }
};
