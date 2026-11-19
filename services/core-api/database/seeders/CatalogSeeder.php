<?php

namespace Database\Seeders;

use App\Models\Brand;
use App\Models\Inventory;
use App\Models\Product;
use App\Models\ProductVariant;
use Illuminate\Database\Seeder;
use RuntimeException;
use Symfony\Component\Yaml\Yaml;

/**
 * 種子商品（AIC-011）：database/seed-assets/catalog/
 *   products/<slug>.md  敘述：front matter（名稱、類別、適用、不適用提醒）＋內文
 *   catalog.json        數字：品牌、交付方式、每個 SKU 的價格、規格、初始庫存、餵食量
 * 內容是手寫的（原本是 AI 客服 support 的資料，搬進商店後由這裡提供）。
 *
 * 可以重跑：商品和 SKU 以 slug／SKU 對應，敘述和規格會更新；庫存只在 SKU 第一次建立時設定，不蓋掉後台改過的數量。
 */
class CatalogSeeder extends Seeder
{
    // 一定要寫，沒有就寫 []：「沒寫」和「寫了沒有」要分得出來
    private const REQUIRED_LISTS = ['species', 'life_stage', 'concerns', 'warnings'];

    // 數字只有一個來源（catalog.json）。敘述寫了數字，AI 可能拿來回答，和資料庫各說各話
    private const NUMBER_WITH_UNIT = '/\d+(?:\.\d+)?\s*(?:g|kg|公克|公斤|元|天|%|％|罐|包|錠|顆|盒|個|匙|ml|毫升|L)/u';

    public function __construct(private ?string $dir = null)
    {
        $this->dir ??= database_path('seed-assets/catalog');
    }

    public function run(): void
    {
        $catalog = json_decode(file_get_contents("{$this->dir}/catalog.json"), true, flags: JSON_THROW_ON_ERROR);
        $brands = Brand::pluck('id', 'project_code');

        foreach ($catalog['products'] as $item) {
            $doc = $this->readDoc($item['slug']);
            $brandId = $brands[$item['brand']] ?? throw new RuntimeException("{$item['slug']}：沒有品牌 {$item['brand']}");

            $product = Product::updateOrCreate(['slug' => $item['slug']], [
                'brand_id' => $brandId,
                'name' => $doc['name'],
                'category' => $doc['category'],
                'species' => $doc['species'],
                'life_stage' => $doc['life_stage'],
                'concerns' => $doc['concerns'],
                'warnings' => $doc['warnings'],
                'description_md' => $doc['body'],
                'feeding' => $item['feeding'],
                'delivery_modes' => $item['delivery_modes'],
            ]);

            foreach ($item['variants'] as $v) {
                $variant = ProductVariant::updateOrCreate(['sku' => $v['sku']], [
                    'product_id' => $product->id,
                    'name' => trim(implode(' ', array_filter([$doc['name'], $v['flavor'], $v['size_label']]))),
                    'flavor' => $v['flavor'],
                    'size_label' => $v['size_label'],
                    'price' => $v['price'],
                    'net_weight_g' => $v['net_weight_g'],
                    'dimensions_mm' => $v['dimensions_mm'],
                    'shelf_life_days' => $v['shelf_life_days'],
                    'storage' => $v['storage'],
                    'packaging' => $v['packaging'],
                    'shipping_class' => $v['shipping_class'],
                    'is_litter' => $v['shipping_class'] === 'litter',
                    'service_type' => $v['service_type'] ?? null,
                ]);
                // 新建的實體商品已經自動有一列桶 0 的庫存（0）；只有這時候設定初始數量
                if ($variant->wasRecentlyCreated && $v['stock'] !== null) {
                    Inventory::where('variant_id', $variant->id)->where('bucket_no', 0)->update(['on_hand' => $v['stock']]);
                }
            }
        }
    }

    /** 驗證失敗就拋錯：資料有問題時，種子就要失敗，而不是讓前台或 AI 拿到不完整的資料 */
    private function readDoc(string $slug): array
    {
        $file = "{$this->dir}/products/{$slug}.md";
        $text = is_file($file) ? file_get_contents($file) : throw new RuntimeException("{$slug}：找不到 {$slug}.md");
        if (! preg_match('/^---\n(.*?)\n---\n(.*)$/s', $text, $m)) {
            throw new RuntimeException("{$slug}.md：缺少 front matter");
        }
        $meta = Yaml::parse($m[1]) ?? [];
        $body = trim($m[2]);

        if (($meta['slug'] ?? null) !== $slug) {
            throw new RuntimeException("{$slug}.md：slug 要和檔名一致");
        }
        foreach (['name', 'category'] as $key) {
            if (! is_string($meta[$key] ?? null) || $meta[$key] === '') {
                throw new RuntimeException("{$slug}.md：缺少 {$key}");
            }
        }
        foreach (self::REQUIRED_LISTS as $key) {
            if (! is_array($meta[$key] ?? null) || ! array_is_list($meta[$key])) {
                throw new RuntimeException("{$slug}.md：{$key} 要寫成清單，沒有就寫 []");
            }
        }
        foreach ([$body, ...$meta['warnings']] as $text) {
            if (preg_match(self::NUMBER_WITH_UNIT, $text)) {
                throw new RuntimeException("{$slug}.md：敘述不能寫數字，數字放 catalog.json");
            }
        }

        return [...$meta, 'body' => $body];
    }
}
