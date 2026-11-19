<?php

namespace App\Domain\Distribution;

use App\Domain\DomainException;
use App\Models\DistributorShop;
use App\Models\DistributorUser;
use App\Models\Product;
use App\Models\ShopItem;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/** 經銷商或業務勾選 shop 要顯示的商品：檢查、整包替換，同一個交易。禁令在下單時才掃描 */
class ShopItemSettings
{
    public function __construct(private ShopCatalog $catalog) {}

    /** @param  list<int>  $productIds  完整的勾選清單 */
    public function replace(DistributorShop $shop, array $productIds, User|DistributorUser $by): void
    {
        $productIds = array_values(array_unique(array_map('intval', $productIds)));

        DB::transaction(function () use ($shop, $productIds) {
            DistributorShop::whereKey($shop->id)->lockForUpdate()->sole();   // 兩個人同時存，一個一個來

            $allowed = array_column($this->catalog->allowed($shop), 'product_id');
            $notAllowed = array_diff($productIds, $allowed);
            if ($notAllowed !== []) {
                $skus = Product::whereIn('id', $notAllowed)->pluck('sku')->implode('、');
                throw new DomainException('item_not_in_contract', "合約沒有這些商品：{$skus}");
            }

            $current = $shop->items()->pluck('product_id')->all();
            $added = array_values(array_diff($productIds, $current));

            // 只動合約還允許的：合約暫時拿掉的品項，設定要留著，之後加回來才會恢復
            ShopItem::where('shop_id', $shop->id)->whereIn('product_id', $allowed)->whereNotIn('product_id', $productIds)->delete();
            foreach ($added as $productId) {
                ShopItem::create(['shop_id' => $shop->id, 'product_id' => $productId]);
            }
        });
    }
}
