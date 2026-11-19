<?php

namespace App\Domain\Distribution;

use App\Domain\DomainException;
use App\Enums\Incoterm;
use App\Models\Product;

/** 合約和範本共用的檢查（AC-10）。第一階一定從 1 箱開始：未達 MOQ 也能送出，要查得到單價 */
class ContractValidator
{
    /** @param  array<string, mixed>  $terms */
    public function assertValid(array $terms): void
    {
        if ($errors = $this->errors($terms)) {
            throw new DomainException('contract_invalid', implode('；', $errors), 422, ['errors' => $errors]);
        }
    }

    /**
     * @param  array<string, mixed>  $terms
     * @return list<string>
     */
    public function errors(array $terms): array
    {
        $errors = [];
        if (Incoterm::tryFrom((string) ($terms['incoterm'] ?? '')) === null) {
            $errors[] = 'Incoterm 只能是 CIF 或 FOB';
        }
        if (! $this->isBps($terms['prepay_bps'] ?? null)) {
            $errors[] = '預付比例要在 0%～100%';
        }
        if (! $this->isBps($terms['early_bird_discount_bps'] ?? null)) {
            $errors[] = '早鳥折扣要在 0%～100%';
        }
        if ((int) ($terms['min_lead_days'] ?? -1) < 0) {
            $errors[] = '早鳥最短交期不能是負數';
        }

        $items = $terms['items'] ?? [];
        $products = Product::whereIn('id', array_column($items, 'product_id'))->get()->keyBy('id');
        $seen = [];
        foreach ($items as $item) {
            $product = $products->get((int) ($item['product_id'] ?? 0));
            $sku = $product->sku ?? '（未選）';
            if (! $product) {
                $errors[] = '有品項沒有選商品';
            }
            if (isset($seen[$sku])) {
                $errors[] = "{$sku}：商品重複";
            }
            $seen[$sku] = true;

            foreach (['moq_cases' => 'MOQ', 'case_size' => '每箱件數', 'case_multiple' => '箱數倍數'] as $field => $label) {
                if ((int) ($item[$field] ?? 0) < 1) {
                    $errors[] = "{$sku}：{$label}至少要 1";
                }
            }
            array_push($errors, ...$this->tierErrors($sku, $item['tiers'] ?? []));
        }

        return $errors;
    }

    /**
     * @param  array<int, array<string, mixed>>  $tiers
     * @return list<string>
     */
    private function tierErrors(string $sku, array $tiers): array
    {
        if ($tiers === []) {
            return ["{$sku}：至少要有一個階梯"];
        }

        $errors = [];
        $mins = array_map(fn ($t) => (int) ($t['min_cases'] ?? 0), $tiers);
        if (count($mins) !== count(array_unique($mins))) {
            $errors[] = "{$sku}：階梯門檻重複";
        }
        if (min($mins) !== 1) {
            $errors[] = "{$sku}：第一階必須從 1 箱開始";
        }
        foreach ($tiers as $tier) {
            if ((int) ($tier['unit_price_minor'] ?? 0) <= 0) {
                $errors[] = "{$sku}：單價要大於 0";
            }
        }

        return $errors;
    }

    private function isBps(mixed $value): bool
    {
        return is_numeric($value) && (int) $value >= 0 && (int) $value <= 10000;
    }
}
