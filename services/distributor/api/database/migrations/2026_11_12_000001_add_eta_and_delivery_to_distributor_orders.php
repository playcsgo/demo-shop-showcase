<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** 拿掉已完工和待出貨這一層；業務改填 ETA，多一個已送達。既有資料直接轉，不用重建 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('distributor_orders', function (Blueprint $table) {
            $table->date('eta_date')->nullable();
            $table->foreignId('delivered_by_user_id')->nullable()->constrained('users');
            $table->timestamp('delivered_at')->nullable();
            $table->dropConstrainedForeignId('completed_by_user_id');
            $table->dropColumn('completed_at');
        });

        Schema::create('distributor_order_eta_changes', function (Blueprint $table) {
            $table->id();
            $table->foreignId('order_id')->constrained('distributor_orders')->cascadeOnDelete();
            $table->date('before_date')->nullable();
            $table->date('after_date')->nullable();
            $table->foreignId('changed_by_user_id')->constrained('users');
            $table->timestamp('created_at')->nullable();
        });

        DB::table('distributor_orders')->whereIn('status', ['PRODUCTION_SCHEDULED', 'READY_TO_SHIP'])->update(['status' => 'IN_PROGRESS']);
        DB::table('distributor_batches')->where('status', 'PAID')->update(['status' => 'PROCESSING']);
    }

    public function down(): void
    {
        DB::table('distributor_batches')->whereIn('status', ['PROCESSING', 'COMPLETED', 'AWAITING_START'])->update(['status' => 'PAID']);
        DB::table('distributor_orders')->where('status', 'DELIVERED')->update(['status' => 'SHIPPED']);
        DB::table('distributor_orders')->where('status', 'IN_PROGRESS')->update(['status' => 'READY_TO_SHIP']);

        Schema::dropIfExists('distributor_order_eta_changes');
        Schema::table('distributor_orders', function (Blueprint $table) {
            $table->foreignId('completed_by_user_id')->nullable()->constrained('users');
            $table->timestamp('completed_at')->nullable();
            $table->dropConstrainedForeignId('delivered_by_user_id');
            $table->dropColumn(['delivered_at', 'eta_date']);
        });
    }
};
