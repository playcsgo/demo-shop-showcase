<?php

namespace Database\Seeders;

use App\Models\Brand;
use App\Models\Customer;
use App\Models\LegalEntity;
use App\Models\MerchantAccount;
use App\Models\User;
use Illuminate\Database\Seeder;

/**
 * 虛構情境（system-design §2）：汪（平台、唯一賣方）／喵（供應商）、4 個品牌、15 個商品
 * 品牌：汪的柴犬手作坊（狗吃的）、秋田工作室（狗用的，含健康檢查）；喵的藍貓咖啡（貓吃的）、喵玩具（貓用的）（AIC-011）
 */
class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $wang = LegalEntity::create(['code' => 'WANG', 'name' => '汪股份有限公司', 'tax_id' => '00000001', 'role' => 'platform']);
        $miao = LegalEntity::create(['code' => 'MIAO', 'name' => '喵股份有限公司', 'tax_id' => '00000002', 'role' => 'supplier']);

        $miao->contracts()->create(['commission_bps' => 1500, 'effective_from' => '2026-01-01']); // 汪向喵抽 15%

        MerchantAccount::create([
            'legal_entity_id' => $wang->id,
            'provider' => 'mockpay',
            'merchant_id' => 'WANG-MOCKPAY-001',
            'secret_ref' => 'env:MOCKPAY_WEBHOOK_SECRET',
        ]);

        $ak = Brand::create(['legal_entity_id' => $wang->id, 'project_code' => 'AK', 'name' => '秋田工作室']);
        $sb = Brand::create(['legal_entity_id' => $wang->id, 'project_code' => 'SB', 'name' => '柴犬手作坊']);
        $bc = Brand::create(['legal_entity_id' => $miao->id, 'project_code' => 'BC', 'name' => '藍貓咖啡']);
        $mt = Brand::create(['legal_entity_id' => $miao->id, 'project_code' => 'MT', 'name' => '喵玩具']);

        $this->call(CatalogSeeder::class);         // 商品、SKU、初始庫存（database/seed-assets/catalog/）
        $this->call(ProductImageSeeder::class);   // 商品圖片上傳到 S3

        // 後台使用者（角色在 M9 指派）；密碼都是 0204
        User::create(['name' => '系統管理員', 'email' => 'admin@example.test', 'password' => '0204']);
        User::create(['name' => '財務', 'email' => 'finance@example.test', 'password' => '0204']);
        User::create(['name' => '汪營運', 'email' => 'wang-operator@example.test', 'password' => '0204', 'legal_entity_id' => $wang->id]);
        User::create(['name' => '喵營運', 'email' => 'miao-operator@example.test', 'password' => '0204', 'legal_entity_id' => $miao->id]);
        User::create(['name' => '汪品牌經理', 'email' => 'wang-manager@example.test', 'password' => '0204'])->brands()->attach([$ak->id, $sb->id]);
        User::create(['name' => '秋田品牌經理', 'email' => 'ak-manager@example.test', 'password' => '0204'])->brands()->attach([$ak->id]);
        User::create(['name' => '藍貓品牌經理', 'email' => 'bc-manager@example.test', 'password' => '0204'])->brands()->attach([$bc->id]);
        User::create(['name' => '喵玩具品牌經理', 'email' => 'mt-manager@example.test', 'password' => '0204'])->brands()->attach([$mt->id]);
        User::create(['name' => '客服', 'email' => 'cs@example.test', 'password' => '0204'])->brands()->attach([$ak->id, $sb->id, $bc->id, $mt->id]);

        $this->call(RolesSeeder::class);

        Customer::create(['email' => 'alice@example.test', 'name' => 'Alice', 'password' => '0204', 'payment_token_ref' => 'tok_mock_alice']);
        Customer::create(['email' => 'bob@example.test', 'name' => 'Bob', 'password' => '0204', 'payment_token_ref' => 'tok_mock_bob']);

        // 混沌測試／壓測用的顧客：shopper01～shopper30
        $hash = bcrypt('0204');
        foreach (range(1, 30) as $i) {
            $n = str_pad((string) $i, 2, '0', STR_PAD_LEFT);
            Customer::create(['email' => "shopper{$n}@example.test", 'name' => "Shopper {$n}", 'password' => $hash, 'payment_token_ref' => "tok_mock_{$n}"]);
        }
    }
}
