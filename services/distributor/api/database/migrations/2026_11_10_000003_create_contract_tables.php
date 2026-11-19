<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * 範本和合約（SIL-002）
 *  - 範本屬於建立它的業務；帶入合約是複製，不是參照：改範本不能影響已簽的合約
 *  - 範本的階梯用 JSON（只會整份讀取）；合約的階梯用資料表（要查價、要加限制）
 *  - 合約有版本，舊版保留；比例用萬分比，金額用最小單位的整數
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('contract_templates', function (Blueprint $table) {
            $table->id();
            $table->foreignId('owner_user_id')->constrained('users');
            $table->string('name');
            $table->char('currency', 3);
            $table->string('incoterm', 10);
            $table->unsignedSmallInteger('prepay_bps');
            $table->unsignedSmallInteger('early_bird_discount_bps');
            $table->unsignedSmallInteger('min_lead_days')->default(60);
            $table->timestamps();
            $table->unique(['owner_user_id', 'name']);
        });
        DB::statement('ALTER TABLE contract_templates ADD CONSTRAINT chk_template_bps CHECK (prepay_bps <= 10000 AND early_bird_discount_bps <= 10000)');

        Schema::create('contract_template_items', function (Blueprint $table) {
            $table->id();
            $table->foreignId('template_id')->constrained('contract_templates')->cascadeOnDelete();
            $table->foreignId('product_id')->constrained('products')->cascadeOnDelete();
            $table->unsignedInteger('moq_cases');
            $table->unsignedInteger('case_size');
            $table->unsignedInteger('case_multiple')->default(1);
            $table->json('tiers');   // [{"min_cases":1,"unit_price_minor":10000}]
            $table->timestamps();
            $table->unique(['template_id', 'product_id']);
        });

        Schema::create('distributor_contracts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('distributor_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('version');
            $table->string('status', 20);   // draft／active／superseded
            $table->string('incoterm', 10);
            $table->unsignedSmallInteger('prepay_bps');
            $table->unsignedSmallInteger('early_bird_discount_bps');
            $table->unsignedSmallInteger('min_lead_days');
            $table->foreignId('source_template_id')->nullable()->constrained('contract_templates')->nullOnDelete();
            $table->foreignId('activated_by_user_id')->nullable()->constrained('users');
            $table->timestamp('activated_at')->nullable();
            $table->timestamps();
            $table->unique(['distributor_id', 'version']);
        });
        DB::statement('ALTER TABLE distributor_contracts ADD CONSTRAINT chk_contract_bps CHECK (prepay_bps <= 10000 AND early_bird_discount_bps <= 10000)');

        Schema::create('contract_items', function (Blueprint $table) {
            $table->id();
            $table->foreignId('contract_id')->constrained('distributor_contracts')->cascadeOnDelete();
            $table->foreignId('product_id')->constrained('products')->cascadeOnDelete();
            $table->unsignedInteger('moq_cases');
            $table->unsignedInteger('case_size');
            $table->unsignedInteger('case_multiple')->default(1);
            $table->timestamps();
            $table->unique(['contract_id', 'product_id']);
        });

        Schema::create('contract_item_tiers', function (Blueprint $table) {
            $table->id();
            $table->foreignId('contract_item_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('min_cases');
            $table->unsignedInteger('unit_price_minor');
            $table->timestamps();
            $table->unique(['contract_item_id', 'min_cases']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('contract_item_tiers');
        Schema::dropIfExists('contract_items');
        Schema::dropIfExists('distributor_contracts');
        Schema::dropIfExists('contract_template_items');
        Schema::dropIfExists('contract_templates');
    }
};
