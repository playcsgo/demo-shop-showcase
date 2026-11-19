<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** 完工和出貨（SIL-006）：逐張按，記誰、何時。索引給需求合併看板用 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('distributor_orders', function (Blueprint $table) {
            $table->foreignId('completed_by_user_id')->nullable()->constrained('users');
            $table->timestamp('completed_at')->nullable();
            $table->foreignId('shipped_by_user_id')->nullable()->constrained('users');
            $table->timestamp('shipped_at')->nullable();
            $table->index(['status', 'requested_ship_date']);
        });
    }

    public function down(): void
    {
        Schema::table('distributor_orders', function (Blueprint $table) {
            $table->dropIndex(['status', 'requested_ship_date']);
            $table->dropConstrainedForeignId('completed_by_user_id');
            $table->dropColumn('completed_at');
            $table->dropConstrainedForeignId('shipped_by_user_id');
            $table->dropColumn('shipped_at');
        });
    }
};
