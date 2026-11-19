<?php

namespace App\Domain\Distribution;

use App\Enums\DistributorOrderStatus;
use Illuminate\Support\Facades\DB;

/**
 * 需求合併看板：確定的早鳥需求按 SKU×出貨月份合計，交給生管一次排產。系統不展開配方、不算成本。
 *  - 只算「安排生產」：還沒收款的不算確定需求，現貨不用生產
 *  - 合計用件數：不同合約的每箱件數可能不同，箱數不能直接加總
 *  - 即時查詢，不存彙總表：demo 的資料量不需要，也不會有不同步的問題
 */
class DemandBoard
{
    /** @return list<array{ship_month: string, product_id: int, sku: string, name: string, temperature_class: string, total_units: int, order_count: int}> */
    public function rows(): array
    {
        return DB::table('distributor_orders as o')
            ->join('distributor_order_items as i', 'i.order_id', '=', 'o.id')
            ->join('products as v', 'v.id', '=', 'i.product_id')
            ->where('o.status', DistributorOrderStatus::InProgress->value)
            ->whereNotNull('o.requested_ship_date')   // 只有早鳥有交期；現貨不用排產
            ->groupBy('ship_month', 'i.product_id', 'v.sku', 'v.name', 'v.temperature_class')
            ->orderBy('ship_month')->orderBy('v.sku')
            ->selectRaw("DATE_FORMAT(o.requested_ship_date, '%Y-%m') AS ship_month, i.product_id, v.sku, v.name, v.temperature_class,
                SUM(i.qty_units) AS total_units, COUNT(DISTINCT o.id) AS order_count")
            ->get()
            ->map(fn (object $r) => [
                'ship_month' => $r->ship_month, 'product_id' => (int) $r->product_id, 'sku' => $r->sku, 'name' => $r->name,
                'temperature_class' => $r->temperature_class, 'total_units' => (int) $r->total_units, 'order_count' => (int) $r->order_count,
            ])->all();
    }

    /** 這一格是哪些單 @return list<array<string, mixed>> */
    public function details(string $shipMonth, int $productId): array
    {
        return DB::table('distributor_orders as o')
            ->join('distributor_order_items as i', 'i.order_id', '=', 'o.id')
            ->join('distributor_shops as s', 's.id', '=', 'o.shop_id')
            ->join('distributors as d', 'd.id', '=', 's.distributor_id')
            ->where('o.status', DistributorOrderStatus::InProgress->value)
            ->whereNotNull('o.requested_ship_date')
            ->where('i.product_id', $productId)
            ->whereRaw("DATE_FORMAT(o.requested_ship_date, '%Y-%m') = ?", [$shipMonth])
            ->orderBy('o.requested_ship_date')->orderBy('o.id')
            ->get(['o.order_no', 'd.name as distributor_name', 's.name as shop_name', 'i.qty_cases', 'i.qty_units', 'o.requested_ship_date'])
            ->map(fn (object $r) => (array) $r)->all();
    }

    /** @param  resource  $stream  匯出時邊寫邊送，不先組好整份字串 */
    public function writeCsv($stream): void
    {
        fwrite($stream, "\xEF\xBB\xBF");   // BOM：Excel 才認得 UTF-8
        fputcsv($stream, ['出貨月份', 'SKU', '商品', '溫層', '件數', '訂單數'], escape: '');
        foreach ($this->rows() as $r) {
            fputcsv($stream, array_map(fn ($v) => self::csvCell((string) $v), [$r['ship_month'], $r['sku'], $r['name'], $r['temperature_class'], $r['total_units'], $r['order_count']]), escape: '');
        }
    }

    public function csv(): string
    {
        $stream = fopen('php://memory', 'r+');
        $this->writeCsv($stream);
        rewind($stream);
        $csv = stream_get_contents($stream);
        fclose($stream);

        return (string) $csv;
    }

    /** 防公式注入：Excel 會把開頭是 = + - @ 的格子當公式執行，前面加單引號就變成文字 */
    public static function csvCell(string $value): string
    {
        return in_array(substr($value, 0, 1), ['=', '+', '-', '@', "\t", "\r"], true) ? "'{$value}" : $value;
    }
}
