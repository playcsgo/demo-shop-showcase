<?php

namespace Database\Seeders;

use App\Domain\Catalog\InventoryService;
use App\Domain\Distribution\BatchReview;
use App\Domain\Distribution\BatchSubmission;
use App\Domain\Distribution\ContractActivator;
use App\Domain\Distribution\ContractDrafts;
use App\Domain\Distribution\CountryBanService;
use App\Domain\Distribution\CountryRuleService;
use App\Domain\Distribution\ShopItemSettings;
use App\Enums\DistributorUserRole;
use App\Enums\TemperatureClass;
use App\Models\ContractTemplate;
use App\Models\Distributor;
use App\Models\DistributorBatch;
use App\Models\DistributorShop;
use App\Models\DistributorUser;
use App\Models\Product;
use App\Models\Ingredient;
use App\Models\User;
use Illuminate\Database\Seeder;

/**
 * 經銷商 demo 資料（都是虛構的；密碼都是 0204）。可以重複執行：
 *   php artisan db:seed
 */
class DistributorDemoSeeder extends Seeder
{
    public function run(): void
    {
        $this->distributors();
        $this->products();
        $this->countryRules();
        $this->templatesAndContracts();
        $this->shopItems();
        $this->stock();
        // 測試要自己控制有哪些批次，不預先塞；需要的測試直接呼叫 demoBatches()
        if (! app()->runningUnitTests()) {
            $this->demoBatches();
        }
    }

    private function distributors(): void
    {
        $salesA = User::where('email', 'sales-a@example.test')->value('id');
        $salesB = User::where('email', 'sales-b@example.test')->value('id');

        // [代碼, 名稱, 幣別, 業務, 帳號前綴, shops（名稱, 國家, 城市, 地址, 港口）]
        $distributors = [
            ['D-PACIFIC', '太平洋寵物貿易', 'USD', $salesA, 'pacific', [
                ['香港門市', 'HK', 'Hong Kong', '示意地址 1 號', 'Hong Kong'],
                ['新加坡門市', 'SG', 'Singapore', '示意地址 2 號', 'Singapore'],
                ['澳門門市', 'MO', 'Macau', '示意地址 3 號', 'Macau'],
            ]],
            ['D-ISLAND', '島嶼寵物用品', 'TWD', $salesA, 'island', [
                ['台北倉', 'TW', '台北市', '示意地址 4 號', null],
            ]],
            ['D-NORTH', '北海寵物貿易', 'USD', $salesB, 'north', [
                ['大阪門市', 'JP', 'Osaka', '示意地址 5 號', 'Osaka'],
            ]],
        ];

        foreach ($distributors as [$code, $name, $currency, $sales, $prefix, $shops]) {
            $d = Distributor::updateOrCreate(['code' => $code], ['name' => $name, 'currency' => $currency, 'sales_user_id' => $sales]);

            foreach ([DistributorUserRole::Manager, DistributorUserRole::Buyer] as $role) {
                DistributorUser::firstOrCreate(
                    ['email' => "{$prefix}-{$role->value}@example.test"],
                    ['distributor_id' => $d->id, 'name' => "{$name} {$role->value}", 'password' => bcrypt('0204'), 'role' => $role],
                );
            }
            foreach ($shops as [$shop, $country, $city, $address, $port]) {
                $d->shops()->updateOrCreate(['name' => $shop], ['country_code' => $country, 'city' => $city, 'address' => $address, 'destination_port' => $port]);
            }
        }
    }

    /** 經銷商自己的商品，和商店分開 */
    private function products(): void
    {
        // [SKU, 中文名稱, 溫層]
        $products = [
            ['AK-DOGHOUSE', '陶朱隱園狗屋', TemperatureClass::Ambient],
            ['AK-GPS-COLLAR', 'GPS 項圈', TemperatureClass::Ambient],
            ['AK-PLUSH', '布偶', TemperatureClass::Ambient],
            ['BC-CATGRASS', '貓草', TemperatureClass::Ambient],
            ['BC-LITTER', '貓砂', TemperatureClass::Ambient],
            ['BC-PAPER-CASTLE', '新天鵝紙城堡', TemperatureClass::Ambient],
            ['BC-TEASER', '逗貓棒', TemperatureClass::Ambient],
            ['SB-B2B-CANNED', '主食罐', TemperatureClass::Ambient],
            ['SB-B2B-FROZEN', '冷凍鮮食', TemperatureClass::Frozen],
            ['SB-DENTAL-BONE', '潔牙骨頭', TemperatureClass::Ambient],
            ['SB-DOG-FOOD', '狗糧', TemperatureClass::Ambient],
            ['SB-VITAMIN', '寵物維他命', TemperatureClass::Ambient],
        ];
        foreach ($products as [$sku, $name, $temperature]) {
            Product::firstOrCreate(['sku' => $sku], ['name' => $name, 'temperature_class' => $temperature]);
        }
    }

    /** 全部是示意資料，不代表真實法規 */
    private function countryRules(): void
    {
        $sales = User::where('email', 'sales-a@example.test')->firstOrFail();

        // [SKU, HS code 預設值, 成分]；SB-DENTAL-BONE 故意不填，示範「未填成分」和「缺 HS code」
        $products = [
            ['SB-DOG-FOOD', '2309.10', ['牛肉', '雞肉']],
            ['SB-VITAMIN', '2309.90', ['保健成分']],
            ['SB-B2B-CANNED', '2309.10', ['雞肉']],
            ['SB-B2B-FROZEN', '2309.10', ['豬肉']],
        ];
        foreach ($products as [$sku, $hsCode, $ingredients]) {
            $product = Product::where('sku', $sku)->firstOrFail();
            $product->update(['hs_code' => $hsCode]);
            $product->ingredients()->sync(array_map(fn (string $name) => Ingredient::firstOrCreate(['name' => $name])->id, $ingredients));
        }
        Product::whereIn('sku', ['AK-PLUSH', 'AK-GPS-COLLAR', 'AK-DOGHOUSE'])->get()->each->update(['no_ingredients' => true]);

        app(CountryRuleService::class)->save(Product::where('sku', 'SB-DOG-FOOD')->value('id'), 'SG', ['hs_code' => '2309.1010'], $sales);

        // [國家, 成分, 原因]
        $bans = [
            ['SG', '保健成分', '示意：保健成分需另外申請'],
            ['SG', '牛肉', '示意：牛肉進口需檢疫'],
            ['IN', '豬肉', '示意：印度禁止豬肉'],
        ];
        foreach ($bans as [$country, $name, $reason]) {
            app(CountryBanService::class)->save($country, Ingredient::firstOrCreate(['name' => $name])->id, $reason, $sales);
        }
    }

    private function templatesAndContracts(): void
    {
        $a = User::where('email', 'sales-a@example.test')->firstOrFail();
        $b = User::where('email', 'sales-b@example.test')->firstOrFail();

        // 汪的 6 個實體商品＋2 個 B2B 商品：[SKU, MOQ, 每箱件數, 倍數, 美金階梯（分）]；流程圖的範例是狗糧 100／95／90
        $usd = [
            ['SB-DOG-FOOD', 50, 6, 1, [[1, 10000], [50, 9500], [100, 9000]]],
            ['SB-DENTAL-BONE', 30, 24, 1, [[1, 6000], [50, 5500]]],
            ['SB-VITAMIN', 20, 24, 2, [[1, 12000], [50, 11000]]],
            ['AK-PLUSH', 10, 12, 1, [[1, 15000]]],
            ['AK-GPS-COLLAR', 5, 10, 1, [[1, 60000], [20, 55000]]],
            ['AK-DOGHOUSE', 1, 1, 1, [[1, 180000]]],
            ['SB-B2B-CANNED', 50, 24, 1, [[1, 5000], [100, 4500]]],
            ['SB-B2B-FROZEN', 20, 12, 1, [[1, 8000], [50, 7500]]],
        ];
        $twd = array_map(fn ($i) => [$i[0], $i[1], $i[2], $i[3], array_map(fn ($tier) => [$tier[0], (int) round($tier[1] * 30 / 100)], $i[4])], $usd);

        $this->template($a, 'A 海外標準', 'USD', 'FOB', 3000, 300, $usd);
        $this->template($a, 'A 台灣標準', 'TWD', 'CIF', 0, 200, $twd);
        $this->template($b, 'B 海外標準', 'USD', 'CIF', 5000, 300, $usd);

        $this->contract('D-PACIFIC', $a, 'FOB', 3000, 300, $usd);
        $this->contract('D-ISLAND', $a, 'CIF', 0, 200, $twd);
        $this->contract('D-NORTH', $b, 'CIF', 5000, 300, array_slice($usd, 0, 3));
    }

    /** 香港、新加坡、澳門都顯示狗糧，合併計價的範例才走得通。已經設定過的 shop 就跳過，不蓋掉 demo 時改的內容 */
    private function shopItems(): void
    {
        $manager = DistributorUser::where('email', 'pacific-manager@example.test')->firstOrFail();
        $skus = ['SB-DOG-FOOD', 'SB-DENTAL-BONE', 'SB-B2B-CANNED', 'SB-B2B-FROZEN'];
        $ids = Product::whereIn('sku', $skus)->pluck('id')->all();

        foreach (DistributorShop::where('distributor_id', $manager->distributor_id)->get() as $shop) {
            if (! $shop->items()->exists()) {
                app(ShopItemSettings::class)->replace($shop, $ids, $manager);
            }
        }
    }

    /** demo 的庫存量。用「補到多少」：重跑不會一直加 */
    private function stock(): void
    {
        $target = ['AK-DOGHOUSE' => 10000, 'AK-GPS-COLLAR' => 20000, 'AK-PLUSH' => 50000, 'SB-VITAMIN' => 100000, 'SB-DOG-FOOD' => 500000, 'SB-DENTAL-BONE' => 5000, 'SB-B2B-CANNED' => 500000, 'SB-B2B-FROZEN' => 200000];

        foreach ($target as $sku => $units) {
            $product = Product::with('inventory')->where('sku', $sku)->firstOrFail();
            $onHand = $product->inventory->on_hand;
            if ($onHand < $units) {
                app(InventoryService::class)->adjust($product->id, $units - $onHand);
            }
        }
    }

    /** 不同月份、不同經銷商的早鳥單，已收款，讓需求合併看板有內容。用固定的 request_key：重跑不會多建 */
    public function demoBatches(): void
    {
        $pacific = DistributorUser::where('email', 'pacific-manager@example.test')->firstOrFail();
        $north = DistributorUser::where('email', 'north-manager@example.test')->firstOrFail();
        $salesA = User::where('email', 'sales-a@example.test')->firstOrFail();
        $salesB = User::where('email', 'sales-b@example.test')->firstOrFail();
        $food = Product::where('sku', 'SB-DOG-FOOD')->value('id');
        $bone = Product::where('sku', 'SB-DENTAL-BONE')->value('id');
        $frozen = Product::where('sku', 'SB-B2B-FROZEN')->value('id');

        $northShop = DistributorShop::where('distributor_id', $north->distributor_id)->firstOrFail();
        // 加上去，不蓋掉 demo 時改的內容
        app(ShopItemSettings::class)->replace($northShop, array_values(array_unique([...$northShop->items()->pluck('product_id')->all(), $food, $bone])), $north);
        $hk = DistributorShop::where('name', '香港門市')->value('id');
        $sg = DistributorShop::where('name', '新加坡門市')->value('id');
        $date = fn (int $days) => now('Asia/Taipei')->addDays($days)->toDateString();

        // [帳號, 業務, key, shop, 交期, [SKU => 箱數]]
        $batches = [
            [$pacific, $salesA, 'seed-board-1', $hk, $date(75), [$food => 100, $frozen => 40]],
            [$pacific, $salesA, 'seed-board-2', $sg, $date(75), [$food => 60]],
            [$north, $salesB, 'seed-board-3', $northShop->id, $date(75), [$food => 80, $bone => 30]],
            [$pacific, $salesA, 'seed-board-4', $hk, $date(110), [$food => 50, $bone => 30]],
        ];
        foreach ($batches as [$user, $sales, $key, $shop, $shipDate, $items]) {
            if (DistributorBatch::where('distributor_id', $user->distributor_id)->where('request_key', $key)->exists()) {
                continue;
            }
            $batch = app(BatchSubmission::class)->submit($user, ['order_type' => 'early_bird', 'orders' => [[
                'shop_id' => $shop, 'requested_ship_date' => $shipDate,
                'items' => array_map(fn (int $v, int $cases) => ['product_id' => $v, 'qty_cases' => $cases], array_keys($items), $items),
            ]]], $key);
            $review = app(BatchReview::class);
            $review->approve($batch, $sales);
            $review->confirmPayment($batch, $sales);
        }
    }

    /** @param  array<int, array<int, mixed>>  $items */
    private function template(User $owner, string $name, string $currency, string $incoterm, int $prepay, int $discount, array $items): void
    {
        $template = ContractTemplate::firstOrCreate(['owner_user_id' => $owner->id, 'name' => $name], [
            'currency' => $currency, 'incoterm' => $incoterm, 'prepay_bps' => $prepay, 'early_bird_discount_bps' => $discount, 'min_lead_days' => 60,
        ]);
        if ($template->wasRecentlyCreated) {
            foreach ($this->itemRows($items) as $row) {
                $template->items()->create($row);
            }
        }
    }

    /** 已經有合約就跳過 @param  array<int, array<int, mixed>>  $items */
    private function contract(string $code, User $by, string $incoterm, int $prepay, int $discount, array $items): void
    {
        $distributor = Distributor::where('code', $code)->firstOrFail();
        if ($distributor->contracts()->exists()) {
            return;
        }

        $drafts = app(ContractDrafts::class);
        $draft = $drafts->blank($distributor);
        $drafts->save($draft, [
            'incoterm' => $incoterm, 'prepay_bps' => $prepay, 'early_bird_discount_bps' => $discount, 'min_lead_days' => 60,
            'items' => $this->itemRows($items),
        ]);
        $activator = app(ContractActivator::class);
        $activator->activate($draft, $by);
    }

    /**
     * @param  array<int, array<int, mixed>>  $items
     * @return list<array<string, mixed>>
     */
    private function itemRows(array $items): array
    {
        return array_map(fn ($i) => [
            'product_id' => Product::where('sku', $i[0])->value('id'),
            'moq_cases' => $i[1], 'case_size' => $i[2], 'case_multiple' => $i[3],
            'tiers' => array_map(fn ($tier) => ['min_cases' => $tier[0], 'unit_price_minor' => $tier[1]], $i[4]),
        ], $items);
    }
}
