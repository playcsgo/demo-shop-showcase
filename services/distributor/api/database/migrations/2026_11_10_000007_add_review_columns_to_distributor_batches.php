<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** 審核和收款（SIL-005）：不串金流，只記誰、何時按 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('distributor_batches', function (Blueprint $table) {
            $table->foreignId('reviewed_by_user_id')->nullable()->constrained('users');
            $table->timestamp('reviewed_at')->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->foreignId('payment_confirmed_by_user_id')->nullable()->constrained('users');
            $table->timestamp('payment_confirmed_at')->nullable();
            $table->foreignId('cancelled_by_user_id')->nullable()->constrained('users');
            $table->timestamp('cancelled_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('distributor_batches', function (Blueprint $table) {
            $table->dropConstrainedForeignId('reviewed_by_user_id');
            $table->dropColumn('reviewed_at');
            $table->dropColumn('approved_at');
            $table->dropConstrainedForeignId('payment_confirmed_by_user_id');
            $table->dropColumn('payment_confirmed_at');
            $table->dropConstrainedForeignId('cancelled_by_user_id');
            $table->dropColumn('cancelled_at');
        });
    }
};
