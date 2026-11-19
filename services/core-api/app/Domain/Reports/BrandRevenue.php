<?php

namespace App\Domain\Reports;

use App\Models\Brand;
use App\Models\LegalEntity;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Illuminate\Support\Carbon;

/**
 * 財報：某個月份、每個品牌一列。汪自己的品牌不寫結算分錄（見 SettlementRecorder），所以直接從 order_items／refund_items 統計。
 *
 * 品牌淨收入 = 銷售 − 退款 − 金流手續費 − 抽成
 * - 汪的品牌：抽成是 0（commission_bps = 0），淨收入就是汪自營的收入
 * - 喵的品牌：抽成付給汪（退款會回沖），淨收入就是汪應付給喵的金額
 * 汪的總收入 = 汪品牌的淨收入 ＋ 喵品牌付的抽成
 *
 * 銷售以付款時間（orders.paid_at）歸月；退款以退款成功時間歸月。萬分比都無條件捨去，和結算分錄算法一致。
 */
class BrandRevenue
{
    /** @param  array<int>|null  $brandScope  null＝全部品牌 */
    public function query(string $period, ?array $brandScope): Builder
    {
        $from = Carbon::createFromFormat('Y-m-d', "{$period}-01")->startOfMonth();
        $to = $from->copy()->addMonth();
        $feeBps = (int) config('shop.payment_fee_bps');

        $sales = fn (string $expr) => fn (QueryBuilder $q) => $q->from('order_items')
            ->join('orders', 'orders.id', '=', 'order_items.order_id')
            ->whereColumn('order_items.brand_id', 'brands.id')
            ->where('orders.paid_at', '>=', $from)->where('orders.paid_at', '<', $to)
            ->selectRaw("COALESCE(SUM({$expr}), 0)");
        $refunds = fn (string $expr) => fn (QueryBuilder $q) => $q->from('refund_items')
            ->join('refunds', 'refunds.id', '=', 'refund_items.refund_id')
            ->join('order_items', 'order_items.id', '=', 'refund_items.order_item_id')
            ->whereColumn('order_items.brand_id', 'brands.id')
            ->where('refunds.status', 'SUCCEEDED')
            ->whereRaw('COALESCE(refunds.succeeded_at, refunds.updated_at) >= ? AND COALESCE(refunds.succeeded_at, refunds.updated_at) < ?', [$from, $to])
            ->selectRaw("COALESCE(SUM({$expr}), 0)");

        $inner = Brand::query()
            ->when($brandScope !== null, fn ($q) => $q->whereIn('brands.id', $brandScope))
            ->select('brands.*')
            ->selectSub(fn (QueryBuilder $q) => $q->from('legal_entities')->whereColumn('legal_entities.id', 'brands.legal_entity_id')->select('name'), 'legal_entity_name')
            ->selectSub(fn (QueryBuilder $q) => $q->from('legal_entities')->whereColumn('legal_entities.id', 'brands.legal_entity_id')->select('role'), 'legal_entity_role')
            ->selectSub($sales('order_items.line_total'), 'gross')
            ->selectSub($refunds('refund_items.amount'), 'refunds')
            ->selectSub($sales("FLOOR(order_items.line_total * {$feeBps} / 10000)"), 'fees')
            ->selectSub($sales('FLOOR(order_items.line_total * order_items.commission_bps / 10000)'), 'commission_gross')
            ->selectSub($refunds('FLOOR(refund_items.amount * order_items.commission_bps / 10000)'), 'commission_reversed');

        // 包一層，才能用上面算好的欄位再算淨收入
        return Brand::query()->fromSub($inner, 'brands')
            ->select('brands.*')
            ->selectRaw('commission_gross - commission_reversed AS commission')
            ->selectRaw('gross - refunds - fees - (commission_gross - commission_reversed) AS net_income')
            ->orderBy('brands.legal_entity_id')->orderBy('brands.id');
    }

    /** 汪的總收入（只有看得到全部品牌的人才有意義）：汪品牌的淨收入＋喵品牌付的抽成 */
    public function platformIncome(string $period): int
    {
        return (int) $this->query($period, null)->get()
            ->sum(fn ($b) => $b->legal_entity_role === 'platform' ? $b->net_income : $b->commission);
    }
}
