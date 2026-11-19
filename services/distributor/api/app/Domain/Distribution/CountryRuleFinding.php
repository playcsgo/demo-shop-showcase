<?php

namespace App\Domain\Distribution;

/** 一個 SKU 在一個國家的掃描結果 */
final readonly class CountryRuleFinding
{
    /** @param  list<array{name: string, reason: ?string}>  $bannedIngredients */
    public function __construct(
        public int $productId,
        public string $sku,
        public string $country,
        public ?string $hsCode = null,
        public array $bannedIngredients = [],
        public bool $missingIngredients = false,
    ) {}

    public function banned(): bool
    {
        return $this->bannedIngredients !== [];
    }

    public function missingHsCode(): bool
    {
        return $this->hsCode === null;
    }

    public function hasWarning(): bool
    {
        return $this->banned() || $this->missingIngredients || $this->missingHsCode();
    }

    /** API 和警告列表用，也存進批次：規則之後改了，也還原得出當時看到什麼 @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'product_id' => $this->productId, 'sku' => $this->sku, 'country' => $this->country,
            'banned' => $this->banned(), 'banned_ingredients' => $this->bannedIngredients, 'missing_ingredients' => $this->missingIngredients,
            'hs_code' => $this->hsCode, 'missing_hs_code' => $this->missingHsCode(),
        ];
    }
}
