<?php

namespace App\Http\Controllers\Api\B2b;

use App\Domain\Distribution\ShopCatalog;
use App\Domain\Distribution\ShopItemSettings;
use App\Http\Controllers\Controller;
use App\Models\DistributorShop;
use App\Models\DistributorUser;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ShopItemController extends Controller
{
    public function catalog(Request $request, int $id, ShopCatalog $catalog): JsonResponse
    {
        return response()->json(['data' => $catalog->forShop($this->ownShop($request, $id))]);
    }

    public function settings(Request $request, int $id, ShopCatalog $catalog): JsonResponse
    {
        $shop = $this->ownShop($request, $id);
        $selected = $shop->items()->pluck('product_id')->all();

        return response()->json(['data' => array_map(
            fn (array $item) => $item + ['selected' => in_array($item['product_id'], $selected, true)],
            $catalog->allowed($shop),
        )]);
    }

    public function update(Request $request, int $id, ShopItemSettings $settings, ShopCatalog $catalog): JsonResponse
    {
        $shop = $this->ownShop($request, $id);
        $data = $request->validate([
            'product_ids' => ['present', 'array'],
            'product_ids.*' => ['integer'],
        ]);
        /** @var DistributorUser $user */
        $user = $request->user();

        $settings->replace($shop, $data['product_ids'], $user);

        return response()->json(['data' => $catalog->forShop($shop)]);
    }

    /** 別家的 shop 查不到 → 404 */
    private function ownShop(Request $request, int $id): DistributorShop
    {
        /** @var DistributorUser $user */
        $user = $request->user();

        return DistributorShop::where('distributor_id', $user->distributor_id)->findOrFail($id);
    }
}
