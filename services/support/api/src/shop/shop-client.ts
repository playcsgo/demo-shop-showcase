// 商店（core-api）的資料，support 只能透過這個介面拿（AIC-014）。
// 正式的實作是 CoreApiShopClient；測試用 test/fake-shop.ts，不用開整套商店

export const SHOP_CLIENT = Symbol('SHOP_CLIENT');

/** 這次替誰查：變成 X-Support-Actor 標頭，core-api 記進 log */
export type Actor = `customer:${number}` | `staff:${number}` | 'anonymous';

/** 商店掛了、逾時、金鑰錯：工具回錯誤，客戶端轉真人（AC-43） */
export class ShopUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`商店無法使用：${reason}`);
  }
}

export interface ProductIndexEntry {
  slug: string;
  name: string;
  category: string | null;
  brand: string;
  species: string[];
  life_stage: string[];
  concerns: string[];
}

export interface ProductDoc {
  slug: string;
  name: string;
  category: string;
  species: string[];
  life_stage: string[];
  concerns: string[];
  warnings: string[];
  body: string;
}

export interface FeedingRow {
  size_label: string;
  weight_min_kg: number;
  weight_max_kg: number;
  amount_min: number;
  amount_max: number;
  unit: string;
  note: string | null;
}

export interface VariantSummary {
  sku: string;
  flavor: string | null;
  size_label: string | null;
  price: number;
  in_stock: boolean;
}

export type ShippingClass = 'standard' | 'litter' | 'bulky' | 'service';

export interface ProductSpec {
  sku: string;
  product_slug: string;
  name: string;
  flavor: string | null;
  size_label: string | null;
  price: number;
  currency: string;
  shipping_class: ShippingClass;
  net_weight_g: number | null;
  dimensions_mm: { length: number; width: number; height: number } | null;
  shelf_life_days: number | null;
  storage: string | null;
  packaging: string | null;
  available: number | null; // 服務類沒有庫存
  in_stock: boolean;
}

/** 物流商的預估送達時間（AIC-017）：大型物流 demo 打開時，貓砂、狗屋要 20 分鐘 */
export interface DeliveryEstimate {
  sku: string;
  shipping_class: ShippingClass;
  estimated_seconds: number;
  slow: boolean;
  in_stock: boolean;
}

export interface CustomerHit {
  id: number;
  name: string;
  email: string; // 已遮罩
}

export interface OrderSummary {
  order_no: string;
  status: string;
  total: number;
  created_at: string;
  item_count: number;
}

export interface OrderItem {
  id: number;
  sku: string;
  name: string;
  flavor: string | null;
  size_label: string | null;
  qty: number;
  unit_price: number;
  refunded_qty: number;
  fulfillment_type: string;
  fulfillment_status: string;
}

/** 狀態用商店的（PAID、FULFILLING、COMPLETED、PARTIALLY_REFUNDED、REFUNDED…），AI 回答時翻成中文（AC-42） */
export interface Order {
  order_no: string;
  status: string;
  subtotal: number;
  shipping_fee: number;
  total: number;
  paid: boolean;
  refunded_amount: number;
  created_at: string;
  paid_at: string | null;
  items: OrderItem[];
}

export interface Shipment {
  tracking_no: string | null;
  carrier: string;
  shipping_class: string;
  status: string;
  events: { status: string; at: string }[];
  delivered_at: string | null;
  order_item_ids: number[];
}

export interface Refund {
  id: number | string;
  amount: number;
  status: string;
  created_at: string;
  succeeded_at: string | null;
  items: { order_item_id: number; qty: number; amount: number }[];
}

/** 退款的明細：{ 訂單明細 id: 數量 } */
export type RefundLines = Record<number, number>;

export type RefundPreview =
  | { eligible: true; amount: number }
  | { eligible: false; code: string; amount?: number };

/** 商店接受了退款申請：錢還沒退，要等金流（AIC-016） */
export type RefundRequestResult =
  | { status: 'accepted'; refundId: string; amount: number }
  | { status: 'rejected'; code: string };

/** 金流的結果：PENDING 還在處理，SUCCEEDED 之後訂單就是已退款或部分退款 */
export interface RefundState {
  refund_id: number | string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  amount: number;
  order_status: string;
}

export interface ShopClient {
  productIndex(): Promise<ProductIndexEntry[]>;
  productDoc(slug: string): Promise<ProductDoc | null>;
  feeding(slug: string): Promise<FeedingRow[] | null>;
  variants(slug: string): Promise<VariantSummary[] | null>;
  variant(sku: string): Promise<ProductSpec | null>;
  /** 物流商掛了拋 ShopUnavailable（不給假的預估）；服務類、不存在的 SKU 回 null */
  deliveryEstimate(sku: string): Promise<DeliveryEstimate | null>;
  findCustomers(query: string, actor: Actor): Promise<CustomerHit[]>;
  orders(customerId: number, actor: Actor): Promise<OrderSummary[]>;
  order(customerId: number, orderNo: string, actor: Actor): Promise<Order | null>;
  shipments(customerId: number, orderNo: string, actor: Actor): Promise<Shipment[] | null>;
  refunds(customerId: number, orderNo: string, actor: Actor): Promise<Refund[] | null>;
  /** 只算、不寫：提案卡片上的金額來自這裡，不採用模型講的。不是這位客戶的訂單回 null */
  refundPreview(customerId: number, orderNo: string, lines: RefundLines): Promise<RefundPreview | null>;
  /** 冪等：同一個 idempotencyKey 只會退一次 */
  requestRefund(
    customerId: number,
    orderNo: string,
    req: { lines: RefundLines; idempotencyKey: string; staffId: number; proposalId: string },
  ): Promise<RefundRequestResult>;
  /** 申請之後問結果；查不到回 null */
  refundStatus(refundId: string): Promise<RefundState | null>;
}
