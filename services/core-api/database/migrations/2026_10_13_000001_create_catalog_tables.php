<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * 法人、品牌、供應商合約、金流帳號、商品、庫存（system-design §5.2、§5.3）
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('legal_entities', function (Blueprint $table) {
            $table->id();
            $table->string('code', 20)->unique();           // WANG／MIAO
            $table->string('name');
            $table->string('tax_id', 8)->unique();          // 統編
            $table->enum('role', ['platform', 'supplier']); // 汪＝平台（唯一賣方）、喵＝供應商
            $table->timestamps();
        });

        Schema::create('brands', function (Blueprint $table) {
            $table->id();
            $table->foreignId('legal_entity_id')->constrained();
            $table->string('project_code', 10)->unique();   // AK／SB／BC
            $table->string('name');
            $table->timestamps();
        });

        Schema::create('supplier_contracts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('legal_entity_id')->constrained();
            $table->unsignedInteger('commission_bps');      // 抽成（萬分比）：1500 = 15%
            $table->date('effective_from');
            $table->timestamps();
            $table->unique(['legal_entity_id', 'effective_from']);
        });
        DB::statement('ALTER TABLE supplier_contracts ADD CONSTRAINT chk_commission_range CHECK (commission_bps <= 10000)');

        // 汪統一收款：只有一個金流商店帳號
        Schema::create('merchant_accounts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('legal_entity_id')->constrained();
            $table->string('provider', 30);                 // mockpay
            $table->string('merchant_id', 50)->unique();
            $table->string('secret_ref');                   // 只存 Secrets 的參照，不存金鑰本身
            $table->timestamps();
        });

        Schema::create('products', function (Blueprint $table) {
            $table->id();
            $table->foreignId('brand_id')->constrained();
            $table->string('name');
            $table->enum('status', ['active', 'inactive'])->default('active');
            $table->json('delivery_modes');                 // ["direct","warehouse","subscription","booking"] 的子集合
            $table->timestamps();
        });

        Schema::create('product_variants', function (Blueprint $table) {
            $table->id();
            $table->foreignId('product_id')->constrained();
            $table->string('sku', 40)->unique();
            $table->string('name');
            $table->unsignedInteger('price');               // 整數，單位：元
            $table->boolean('is_litter')->default(false);   // 貓砂：寄倉規則用
            $table->enum('shipping_class', ['standard', 'litter', 'bulky', 'service']);
            $table->string('service_type', 30)->nullable(); // 僅 service：health_check
            $table->timestamps();
        });

        // 服務類（預約）不建庫存列
        Schema::create('inventory', function (Blueprint $table) {
            $table->foreignId('variant_id')->primary()->constrained('product_variants');
            $table->integer('on_hand');
            $table->integer('reserved')->default(0);
            $table->timestamps();
        });
        // 第一道防線：就算程式寫錯，資料庫也不允許超賣
        DB::statement('ALTER TABLE inventory ADD CONSTRAINT chk_inventory_non_negative CHECK (reserved >= 0 AND on_hand >= reserved)');
    }

    public function down(): void
    {
        Schema::dropIfExists('inventory');
        Schema::dropIfExists('product_variants');
        Schema::dropIfExists('products');
        Schema::dropIfExists('merchant_accounts');
        Schema::dropIfExists('supplier_contracts');
        Schema::dropIfExists('brands');
        Schema::dropIfExists('legal_entities');
    }
};
