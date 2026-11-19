<?php

namespace App\Http\Controllers\Internal;

use App\Domain\Fulfillment\HubLogisticsGateway;
use App\Domain\Refunds\RefundPolicy;
use App\Domain\Refunds\RefundService;
use App\Http\Controllers\Controller;
use App\Models\Customer;
use App\Models\Order;
use App\Models\Product;
use App\Models\ProductVariant;
use App\Models\Refund;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * AI 客服（support）的 API（AIC-013 唯讀；AIC-016 加上退款），前綴 /api/v1/internal/support，由 SupportServiceKey 擋。
 *
 * 範圍由 support 決定（客戶端只帶本人的 id，客服端只帶目前對話的客戶），這裡再檢查一次：
 * 訂單一律用「customer_id ＋ order_no」一起查，不屬於這位客戶和不存在回一模一樣的 404，不讓人猜訂單在不在。
 * 回傳格式是給 support 用的，不重用前台的 OrderDetailResource：前台改版不會影響 AI 客服。
 */
class SupportController extends Controller
{
    // 給 AI 客服的時間一律是台灣時間：模型會把 UTC 直接當本地時間講（AIC-015 實測抓到）
    private const TZ = 'Asia/Taipei';

    /** 商品索引：AI 先讀這份挑商品，再載入全文 */
    public function products(): JsonResponse
    {
        $products = Product::with('brand')->where('status', 'active')->whereNotNull('slug')->orderBy('id')->get()
            ->map(fn (Product $p) => [
                'slug' => $p->slug, 'name' => $p->name, 'category' => $p->category, 'brand' => $p->brand->name,
                'species' => $p->species ?? [], 'life_stage' => $p->life_stage ?? [], 'concerns' => $p->concerns ?? [],
            ]);

        return response()->json(['data' => $products]);
    }

    public function product(string $slug): JsonResponse
    {
        $p = Product::where('slug', $slug)->where('status', 'active')->firstOrFail();

        return response()->json(['data' => [
            'slug' => $p->slug, 'name' => $p->name, 'category' => $p->category,
            'species' => $p->species ?? [], 'life_stage' => $p->life_stage ?? [], 'concerns' => $p->concerns ?? [],
            'warnings' => $p->warnings ?? [], 'body' => (string) $p->description_md, 'feeding' => $p->feeding ?? [],
        ]]);
    }

    public function variants(string $slug): JsonResponse
    {
        $p = Product::with('variants.buckets')->where('slug', $slug)->where('status', 'active')->firstOrFail();

        return response()->json(['data' => $p->variants->sortBy('id')->values()->map(fn (ProductVariant $v) => [
            'sku' => $v->sku, 'flavor' => $v->flavor, 'size_label' => $v->size_label, 'price' => $v->price,
            'in_stock' => $v->isService() || ($v->stock()?->available() ?? 0) > 0,
        ])]);
    }

    public function variant(string $sku): JsonResponse
    {
        $v = ProductVariant::with('product', 'buckets')->where('sku', $sku)->firstOrFail();
        $available = $v->isService() ? null : ($v->stock()?->available() ?? 0);
        [$l, $w, $h] = $v->dimensions_mm ?? [null, null, null];

        return response()->json(['data' => [
            'sku' => $v->sku, 'product_slug' => $v->product->slug, 'name' => $v->product->name,
            'flavor' => $v->flavor, 'size_label' => $v->size_label, 'price' => $v->price, 'currency' => 'TWD',
            'shipping_class' => $v->shipping_class->value, 'net_weight_g' => $v->net_weight_g,
            'dimensions_mm' => $l === null ? null : ['length' => $l, 'width' => $w, 'height' => $h],
            'shelf_life_days' => $v->shelf_life_days, 'storage' => $v->storage, 'packaging' => $v->packaging,
            'available' => $available, 'in_stock' => $v->isService() || $available > 0,
        ]]);
    }

    /** 預估送達時間（AIC-017）：照 SKU 的運送類別問物流商；服務類不出貨，當成查不到 */
    public function deliveryEstimate(HubLogisticsGateway $logistics, string $sku): JsonResponse
    {
        $v = ProductVariant::with('buckets')->where('sku', $sku)->firstOrFail();
        abort_if($v->isService(), 404);
        $e = $logistics->estimate($v->shipping_class->value);

        return response()->json(['data' => [
            'sku' => $v->sku, 'shipping_class' => $v->shipping_class->value,
            'estimated_seconds' => $e['estimated_seconds'], 'slow' => (bool) ($e['slow'] ?? false),
            'in_stock' => ($v->stock()?->available() ?? 0) > 0,
        ]]);
    }

    /** 客服確認身分用：只回 id、名字、遮罩過的 email；太短或帶萬用字元的查詢不查，避免一次列出所有人 */
    public function customers(Request $request): JsonResponse
    {
        $q = trim((string) $request->query('query', ''));
        if (mb_strlen($q) < 2 || preg_match('/[%_\\\\]/', $q)) {
            throw ValidationException::withMessages(['query' => '至少兩個字，不能有萬用字元']);
        }
        $hits = Customer::where('email', 'like', "{$q}%")->orWhere('name', 'like', "{$q}%")
            ->orderBy('id')->limit(5)->get(['id', 'name', 'email'])
            ->map(fn (Customer $c) => [
                'id' => $c->id, 'name' => $c->name, 'email' => preg_replace('/^(.{2})[^@]*/u', '$1***', $c->email),
            ]);

        return response()->json(['data' => $hits]);
    }

    public function orders(int $customer): JsonResponse
    {
        $orders = Order::where('customer_id', $customer)->latest('id')->limit(20)->withSum('items', 'qty')->get()
            ->map(fn (Order $o) => [
                'order_no' => $o->order_no, 'status' => $o->status->value, 'total' => $o->total,
                'created_at' => $o->created_at->timezone(self::TZ)->toIso8601String(), 'item_count' => (int) $o->items_sum_qty,
            ]);

        return response()->json(['data' => $orders]);
    }

    public function order(int $customer, string $orderNo): JsonResponse
    {
        $o = $this->ownedOrder($customer, $orderNo)->load('items.variant.product', 'payment');
        $refunded = $o->payment?->refunded_amount ?? 0;

        return response()->json(['data' => [
            'order_no' => $o->order_no, 'status' => $o->status->value,
            'subtotal' => $o->subtotal, 'shipping_fee' => $o->shipping_fee, 'total' => $o->total,
            'paid' => $o->payment?->status === 'SUCCEEDED', 'refunded_amount' => $refunded,
            'created_at' => $o->created_at->timezone(self::TZ)->toIso8601String(), 'paid_at' => $o->paid_at?->timezone(self::TZ)->toIso8601String(),
            'items' => $o->items->map(fn ($i) => [
                'id' => $i->id, 'sku' => $i->sku, 'name' => $i->variant->product->name ?? $i->product_name,
                'flavor' => $i->variant->flavor, 'size_label' => $i->variant->size_label,
                'qty' => $i->qty, 'unit_price' => $i->unit_price, 'refunded_qty' => $i->refunded_qty,
                'fulfillment_type' => $i->fulfillment_type->value, 'fulfillment_status' => $i->fulfillment_status->value,
            ])->all(),
        ]]);
    }

    public function shipments(int $customer, string $orderNo): JsonResponse
    {
        $o = $this->ownedOrder($customer, $orderNo)->load('shipments.events', 'shipments.items');

        return response()->json(['data' => $o->shipments->sortBy('seq')->values()->map(fn ($s) => [
            'tracking_no' => $s->tracking_no, 'carrier' => $s->carrier, 'shipping_class' => $s->shipping_class->value,
            'status' => $s->status,
            'events' => $s->events->sortBy('occurred_at')->values()->map(fn ($e) => [
                'status' => $e->status, 'at' => $e->occurred_at->timezone(self::TZ)->toIso8601String(),
            ])->all(),
            'delivered_at' => $s->events->firstWhere('status', 'DELIVERED')?->occurred_at->timezone(self::TZ)->toIso8601String(),
            'order_item_ids' => $s->items->pluck('order_item_id')->filter()->values()->all(),
        ])]);
    }

    public function refunds(int $customer, string $orderNo): JsonResponse
    {
        $o = $this->ownedOrder($customer, $orderNo)->load('refunds.items');

        return response()->json(['data' => $o->refunds->sortBy('id')->values()->map(fn ($r) => [
            'id' => $r->id, 'amount' => $r->amount, 'status' => $r->status,
            'created_at' => $r->created_at->timezone(self::TZ)->toIso8601String(), 'succeeded_at' => $r->succeeded_at?->timezone(self::TZ)->toIso8601String(),
            'items' => $r->items->map(fn ($ri) => ['order_item_id' => $ri->order_item_id, 'qty' => $ri->qty, 'amount' => $ri->amount])->all(),
        ])]);
    }

    /** 退款預覽（AIC-016）：提案卡片的金額和資格來自這裡，不採用模型講的。只算、不寫 */
    public function refundPreview(Request $request, RefundPolicy $policy, int $customer, string $orderNo): JsonResponse
    {
        $order = $this->ownedOrder($customer, $orderNo);

        return response()->json(['data' => $policy->evaluate($order, $this->lines($request))]);
    }

    /**
     * 客服核准 AI 的退款提案（AIC-016）：先過 RefundPolicy，再走原本的 RefundService。
     * 退款是非同步的：這裡回 202 PENDING，金流成功後 RefundCompletion 才把訂單改成已退款
     */
    public function refund(Request $request, RefundService $refunds, int $customer, string $orderNo): JsonResponse
    {
        $order = $this->ownedOrder($customer, $orderNo);
        $data = $request->validate([
            'idempotency_key' => 'required|string|max:80',
            'staff_id' => 'required|integer|min:1',
            'proposal_id' => 'required|string|max:40',
        ]);
        // reason 是分類（欄位只有 50 字）；哪個提案看冪等鍵 support-proposal:<id>
        $refund = $refunds->request($order, $this->lines($request), 'support_proposal',
            $data['idempotency_key'], requestedBy: "support_staff:{$data['staff_id']}");

        return response()->json(['data' => ['refund_id' => $refund->id, 'status' => $refund->status, 'amount' => $refund->amount]], 202);
    }

    public function refundStatus(int $refund): JsonResponse
    {
        $r = Refund::with('order')->findOrFail($refund);

        return response()->json(['data' => ['refund_id' => $r->id, 'status' => $r->status, 'amount' => $r->amount, 'order_status' => $r->order->status->value]]);
    }

    /** @return array<int,int> [order_item_id => qty]；格式不對 422 */
    private function lines(Request $request): array
    {
        $raw = $request->validate(['lines' => 'required|array|min:1|max:50', 'lines.*' => 'integer|min:1|max:999'])['lines'];
        $lines = [];
        foreach ($raw as $id => $qty) {
            if (! ctype_digit((string) $id)) {
                throw ValidationException::withMessages(['lines' => '明細 id 不合法']);
            }
            $lines[(int) $id] = (int) $qty;
        }

        return $lines;
    }

    /** 訂單一定連同客戶一起查：不屬於這位客戶和不存在，對外看起來一樣 */
    private function ownedOrder(int $customer, string $orderNo): Order
    {
        return Order::where('order_no', $orderNo)->where('customer_id', $customer)->firstOrFail();
    }
}
