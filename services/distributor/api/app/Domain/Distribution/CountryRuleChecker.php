<?php

namespace App\Domain\Distribution;

use App\Models\CountryIngredientBan;
use App\Models\Product;
use App\Models\ProductCountryRule;

/** 掃描：SKU 的成分有沒有被該國禁止、HS code 用哪個。國家有值就用國家的，沒有才用 SKU 的預設 */
class CountryRuleChecker
{
    /**
     * @param  list<int>  $productIds
     * @param  list<string>  $countries
     * @return list<CountryRuleFinding>
     */
    public function check(array $productIds, array $countries): array
    {
        $products = Product::with('ingredients')->whereIn('id', $productIds)->get()->keyBy('id');
        $hsCodes = ProductCountryRule::whereIn('product_id', $productIds)->whereIn('country_code', $countries)->get()
            ->keyBy(fn (ProductCountryRule $r) => "{$r->product_id}:{$r->country_code}");
        $bans = CountryIngredientBan::with('ingredient')->whereIn('country_code', $countries)->get()->groupBy('country_code');

        $findings = [];
        foreach ($productIds as $productId) {
            $product = $products[$productId];
            $ingredientIds = $product->ingredients->modelKeys();
            foreach (array_values(array_unique($countries)) as $country) {
                $banned = ($bans[$country] ?? collect())->filter(fn (CountryIngredientBan $b) => in_array($b->ingredient_id, $ingredientIds, true));

                $findings[] = new CountryRuleFinding($productId, $product->sku, $country,
                    $hsCodes->get("{$productId}:{$country}")->hs_code ?? $product->hs_code,
                    $banned->map(fn (CountryIngredientBan $b) => ['name' => $b->ingredient->name, 'reason' => $b->reason])->values()->all(),
                    $ingredientIds === [] && ! $product->no_ingredients);
            }
        }

        return $findings;
    }
}
