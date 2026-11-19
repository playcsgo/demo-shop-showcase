<?php

namespace App\Domain\Distribution;

use App\Domain\DomainException;
use App\Enums\DistributorOrderType;
use App\Models\Distributor;
use App\Models\DistributorContract;
use App\Models\DistributorShop;
use App\Models\Product;
use Carbon\CarbonImmutable;

/**
 * 檢查和計價，不寫入資料。預覽和送出共用：使用者看到的金額和實際建立的不能有差異。
 *
 *   1. 同 SKU 在整批的箱數加總 → 查合約階梯（min_cases 不超過合計的最高一階）
 *   2. 現貨單價＝階梯價；早鳥單價＝階梯價 × (1 − 折扣)，四捨五入到最小單位後才乘數量：每張單單價相同，總額也算得回來
 *   3. 預付＝總額 × 比例，無條件進位：不會少收
 */
class BatchPricer
{
    /** 營運的日期用台北時間：經銷商和業務講的「今天」是這個，app.timezone 維持 UTC */
    public const BUSINESS_TIMEZONE = 'Asia/Taipei';

    public function __construct(private ShopCatalog $catalog, private CountryRuleChecker $rules) {}

    /**
     * @param  array<string, mixed>  $input  order_type、orders[]（shop_id、requested_ship_date、items[]（product_id、qty_cases））
     * @return array<string, mixed>
     */
    public function price(Distributor $distributor, array $input): array
    {
        $contract = DistributorContract::where('distributor_id', $distributor->id)->where('status', 'active')->first()
            ?? throw new DomainException('no_active_contract', '目前沒有生效的合約，請聯絡負責的業務', 409);
        $type = DistributorOrderType::from($input['order_type']);

        $shops = DistributorShop::where('distributor_id', $distributor->id)->whereIn('id', array_column($input['orders'], 'shop_id'))->get()->keyBy('id');
        $lines = $this->validatedLines($input['orders'], $shops->all(), $type, $contract);
        $totals = [];
        foreach ($lines as $line) {
            $totals[$line['product_id']] = ($totals[$line['product_id']] ?? 0) + $line['qty_cases'];
        }

        $orders = [];
        foreach ($input['orders'] as $o) {
            $orders[$o['shop_id']] = [
                'shop_id' => (int) $o['shop_id'], 'shop_name' => $shops[$o['shop_id']]->name,
                'requested_ship_date' => $type === DistributorOrderType::EarlyBird ? $o['requested_ship_date'] : null,
                'subtotal_minor' => 0, 'items' => [],
            ];
        }
        // 每一列掃一次：警告和品項的參考 HS code 都用這份
        $findings = array_map(fn (array $line) => $this->rules->check([$line['product_id']], [$shops[$line['shop_id']]->country_code])[0], $lines);
        foreach ($lines as $i => $line) {
            $unit = $this->unitPrice($line['catalog']['tiers'], $totals[$line['product_id']], $type, $contract);
            $amount = $unit * $line['qty_cases'];
            $orders[$line['shop_id']]['subtotal_minor'] += $amount;
            $orders[$line['shop_id']]['items'][] = [
                'product_id' => $line['product_id'], 'sku' => $line['catalog']['sku'], 'name' => $line['catalog']['name'],
                'qty_cases' => $line['qty_cases'], 'case_size' => $line['catalog']['case_size'],
                'qty_units' => $line['qty_cases'] * $line['catalog']['case_size'],
                'unit_price_minor' => $unit, 'amount_minor' => $amount, 'hs_code' => $findings[$i]->hsCode,
            ];
        }

        $total = array_sum(array_column($orders, 'subtotal_minor'));

        return [
            'order_type' => $type->value,
            'contract_id' => $contract->id,
            'currency' => $distributor->currency,
            'total_minor' => $total,
            'prepay_bps' => $contract->prepay_bps,
            'prepay_minor' => (int) ceil($total * $contract->prepay_bps / 10000),
            'orders' => array_values($orders),
            'moq_results' => $this->moqResults($lines, $totals),
            'warnings' => $this->warnings($lines, $findings, $shops->all()),
            'stock_shortages' => $type === DistributorOrderType::Stock ? $this->stockShortages($lines) : [],
        ];
    }

    /**
     * 每一列都檢查過，才會進到計價（AC-18、AC-19、AC-21、AC-24）
     *
     * @param  array<int, array<string, mixed>>  $orders
     * @param  array<int, DistributorShop>  $shops
     * @return list<array{shop_id: int, product_id: int, qty_cases: int, catalog: array<string, mixed>}>
     */
    private function validatedLines(array $orders, array $shops, DistributorOrderType $type, DistributorContract $contract): array
    {
        $earliest = CarbonImmutable::now(self::BUSINESS_TIMEZONE)->startOfDay()->addDays($contract->min_lead_days);
        $seenShops = [];
        $lines = [];

        foreach ($orders as $order) {
            $shopId = (int) $order['shop_id'];
            $shop = $shops[$shopId] ?? throw new DomainException('shop_not_found', '找不到這個 shop', 404);
            if (isset($seenShops[$shopId])) {
                throw new DomainException('duplicate_shop', "{$shop->name} 重複了：一個 shop 一張單");
            }
            $seenShops[$shopId] = true;

            if ($type === DistributorOrderType::EarlyBird) {
                $date = $order['requested_ship_date'] ?? null;
                if (! $date) {
                    throw new DomainException('ship_date_required', "{$shop->name}：早鳥單要選交期");
                }
                if (CarbonImmutable::parse($date, self::BUSINESS_TIMEZONE)->lt($earliest)) {
                    throw new DomainException('ship_date_too_soon', "{$shop->name}：交期最早是 {$earliest->toDateString()}");
                }
            }

            $available = collect($this->catalog->forShop($shop))->keyBy('product_id');
            $seenItems = [];
            foreach ($order['items'] as $item) {
                $productId = (int) $item['product_id'];
                $cases = (int) $item['qty_cases'];
                $catalog = $available->get($productId) ?? throw new DomainException('item_not_available', "{$shop->name} 沒有這個商品（{$productId}）");
                if (isset($seenItems[$productId])) {
                    throw new DomainException('duplicate_item', "{$shop->name}：{$catalog['sku']} 重複了");
                }
                $seenItems[$productId] = true;
                if ($cases % $catalog['case_multiple'] !== 0) {
                    throw new DomainException('invalid_case_multiple', "{$shop->name}：{$catalog['sku']} 要是 {$catalog['case_multiple']} 箱的倍數");
                }
                $lines[] = ['shop_id' => $shopId, 'product_id' => $productId, 'qty_cases' => $cases, 'catalog' => $catalog];
            }
        }

        return $lines;
    }

    /** @param  array<int, array{min_cases: int, unit_price_minor: int}>  $tiers  由小到大 */
    private function unitPrice(array $tiers, int $totalCases, DistributorOrderType $type, DistributorContract $contract): int
    {
        // 合約檢查保證第一階從 1 箱開始，一定查得到
        $tier = collect($tiers)->last(fn (array $t) => $t['min_cases'] <= $totalCases);

        return $type === DistributorOrderType::EarlyBird
            ? (int) round($tier['unit_price_minor'] * (10000 - $contract->early_bird_discount_bps) / 10000)
            : $tier['unit_price_minor'];
    }

    /**
     * @param  list<array<string, mixed>>  $lines
     * @param  array<int, int>  $totals
     * @return list<array<string, mixed>>
     */
    private function moqResults(array $lines, array $totals): array
    {
        return collect($lines)->unique('product_id')->sortBy('product_id')->values()->map(fn (array $l) => [
            'product_id' => $l['product_id'], 'sku' => $l['catalog']['sku'],
            'total_cases' => $totals[$l['product_id']], 'moq_cases' => $l['catalog']['moq_cases'],
            'met' => $totals[$l['product_id']] >= $l['catalog']['moq_cases'],
        ])->all();
    }

    /**
     * 違反國家禁令只警告，不擋送出，決定權在業務（AC-12、AC-25）
     *
     * @param  list<array<string, mixed>>  $lines
     * @param  list<CountryRuleFinding>  $findings  和 $lines 一一對應
     * @param  array<int, DistributorShop>  $shops
     * @return list<array<string, mixed>>
     */
    private function warnings(array $lines, array $findings, array $shops): array
    {
        $warnings = [];
        foreach ($lines as $i => $line) {
            if ($findings[$i]->hasWarning()) {
                $shop = $shops[$line['shop_id']];
                $warnings[] = ['shop_id' => $shop->id, 'shop_name' => $shop->name] + $findings[$i]->toArray();
            }
        }

        return $warnings;
    }

    /**
     * 預覽時先講哪個 SKU 不夠（不講數量）；真正的判斷在送出時的預留
     *
     * @param  list<array<string, mixed>>  $lines
     * @return list<string>
     */
    private function stockShortages(array $lines): array
    {
        $units = [];
        $skus = [];
        foreach ($lines as $line) {
            $units[$line['product_id']] = ($units[$line['product_id']] ?? 0) + $line['qty_cases'] * $line['catalog']['case_size'];
            $skus[$line['product_id']] = $line['catalog']['sku'];
        }

        return Product::with('inventory')->whereIn('id', array_keys($units))->get()
            ->filter(fn (Product $v) => $v->inventory->available() < $units[$v->id])
            ->map(fn (Product $v) => $skus[$v->id])->values()->all();
    }
}
