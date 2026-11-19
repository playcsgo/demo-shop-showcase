<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Product;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Cache;

class CatalogController extends Controller
{
    public const CACHE_KEY = 'catalog:v4';   // v4：加上敘述、不適用提醒、SKU 規格（換版本號，舊格式的快取不會被讀到）

    /** 商品目錄：Redis cache-aside 5 分鐘；後台改商品時刪快取（§9.3）。價格以結帳時重新計算為準。 */
    public function index(): JsonResponse
    {
        $catalog = Cache::remember(self::CACHE_KEY, 300, fn () => Product::with('brand', 'variants.buckets')
            ->where('status', 'active')->orderByOwner()->get()
            ->map(fn ($p) => [
                'id' => $p->id, 'slug' => $p->slug, 'name' => $p->name,
                'category' => $p->category, 'species' => $p->species ?? [],
                'warnings' => $p->warnings ?? [], 'description_md' => $p->description_md,
                'image_url' => $p->imageUrl(),
                'brand' => ['code' => $p->brand->project_code, 'name' => $p->brand->name],
                'delivery_modes' => $p->delivery_modes,
                'variants' => $p->variants->map(fn ($v) => [
                    'id' => $v->id, 'sku' => $v->sku, 'name' => $v->name,
                    'flavor' => $v->flavor, 'size_label' => $v->size_label, 'price' => $v->price,
                    'shipping_class' => $v->shipping_class->value,
                    'in_stock' => $v->isService() || ($v->stock()?->available() > 0),
                ])->all(),
            ])->all());

        return response()->json(['data' => $catalog]);
    }
}
