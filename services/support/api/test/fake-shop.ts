import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { checkRefund } from './refund-policy.js';
import {
  ShopUnavailable,
  type Actor,
  type CustomerHit,
  type FeedingRow,
  type Order,
  type ProductDoc,
  type ProductIndexEntry,
  type ProductSpec,
  type Refund,
  type RefundLines,
  type Shipment,
  type ShopClient,
} from '../src/shop/shop-client.js';

// 測試用的商店：和 core-api 的 internal support API 回一樣的格式，不用開整套商店。
// 商品資料和 core-api 的種子同一份內容（test/fixtures/catalog，原本是 support 的 data/）

const DIR = join(process.cwd(), 'test', 'fixtures', 'catalog');

interface CatalogVariant {
  sku: string;
  flavor: string | null;
  size_label: string;
  price: number;
  net_weight_g: number | null;
  dimensions_mm: [number, number, number] | null;
  shelf_life_days: number | null;
  storage: string | null;
  packaging: string | null;
  shipping_class: ProductSpec['shipping_class'];
  stock: number;
}
interface CatalogProduct {
  slug: string;
  variants: CatalogVariant[];
  feeding: FeedingRow[];
}

function loadDocs(): Map<string, ProductDoc> {
  const docs = new Map<string, ProductDoc>();
  for (const file of readdirSync(join(DIR, 'products')).filter((f) => f.endsWith('.md'))) {
    const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(
      readFileSync(join(DIR, 'products', file), 'utf8'),
    )!;
    const meta = parse(front) as Omit<ProductDoc, 'body'>;
    docs.set(meta.slug, { ...meta, body: body.trim() });
  }
  return docs;
}

const DOCS = loadDocs();
const CATALOG = (JSON.parse(readFileSync(join(DIR, 'catalog.json'), 'utf8')) as { products: CatalogProduct[] })
  .products;

interface StoredOrder {
  customerId: number;
  order: Order;
  shipments: Shipment[];
  refunds: Refund[];
}

/** 對應 support 舊的訂單狀態，方便測試照原本的寫法建單 */
const STATUS = { paid: 'PAID', shipped: 'FULFILLING', delivered: 'COMPLETED' } as const;

export class FakeShop implements ShopClient {
  /** true：每個呼叫都拋 ShopUnavailable，模擬商店掛掉 */
  down = false;
  /** true：物流商掛了，預估拋 ShopUnavailable（core-api 回 503） */
  logisticsDown = false;
  /** 大型物流 demo（partners 的開關）：打開時貓砂、狗屋 20 分鐘 */
  slowLogistics = false;
  /** 金流的結果：申請之後 refundStatus 回這個（PENDING＝一直沒有結果） */
  refundOutcome: 'SUCCEEDED' | 'FAILED' | 'PENDING' = 'SUCCEEDED';
  /** 呼叫紀錄：[方法, actor]，用來檢查 support 帶的身分 */
  readonly calls: [string, Actor | undefined][] = [];
  customers: { id: number; name: string; email: string }[] = [];
  private stock = new Map<string, number>();
  private orderStore = new Map<string, StoredOrder>();
  private nextItemId = 1;
  private nextRefundId = 1;
  now = () => new Date();

  constructor() {
    this.reset();
  }

  reset() {
    this.down = false;
    this.refundOutcome = 'SUCCEEDED';
    this.logisticsDown = false;
    this.slowLogistics = false;
    this.calls.length = 0;
    this.customers = [];
    this.orderStore.clear();
    this.stock = new Map(CATALOG.flatMap((p) => p.variants.map((v) => [v.sku, v.stock] as const)));
    this.now = () => new Date();
  }

  setStock(sku: string, n: number) {
    this.stock.set(sku, n);
  }

  private hit(method: string, actor?: Actor) {
    this.calls.push([method, actor]);
    if (this.down) throw new ShopUnavailable('down');
  }

  private findVariant(sku: string) {
    for (const p of CATALOG) {
      const v = p.variants.find((x) => x.sku === sku);
      if (v) return { p, v };
    }
    return null;
  }

  async productIndex(): Promise<ProductIndexEntry[]> {
    this.hit('productIndex');
    return [...DOCS.values()].map((d) => ({
      slug: d.slug,
      name: d.name,
      category: d.category,
      brand: 'fake',
      species: d.species,
      life_stage: d.life_stage,
      concerns: d.concerns,
    }));
  }

  async productDoc(slug: string) {
    this.hit('productDoc');
    return DOCS.get(slug) ?? null;
  }

  async feeding(slug: string) {
    this.hit('feeding');
    return CATALOG.find((p) => p.slug === slug)?.feeding ?? null;
  }

  async variants(slug: string) {
    this.hit('variants');
    const p = CATALOG.find((x) => x.slug === slug);
    return p
      ? p.variants.map((v) => ({
          sku: v.sku,
          flavor: v.flavor,
          size_label: v.size_label,
          price: v.price,
          in_stock: (this.stock.get(v.sku) ?? 0) > 0,
        }))
      : null;
  }

  async variant(sku: string): Promise<ProductSpec | null> {
    this.hit('variant');
    const found = this.findVariant(sku);
    if (!found) return null;
    const { p, v } = found;
    const available = this.stock.get(sku) ?? 0;
    const [l, w, h] = v.dimensions_mm ?? [];
    return {
      sku,
      product_slug: p.slug,
      name: DOCS.get(p.slug)!.name,
      flavor: v.flavor,
      size_label: v.size_label,
      price: v.price,
      currency: 'TWD',
      shipping_class: v.shipping_class,
      net_weight_g: v.net_weight_g,
      dimensions_mm: v.dimensions_mm ? { length: l!, width: w!, height: h! } : null,
      shelf_life_days: v.shelf_life_days,
      storage: v.storage,
      packaging: v.packaging,
      available,
      in_stock: available > 0,
    };
  }

  async deliveryEstimate(sku: string) {
    this.hit('deliveryEstimate');
    const found = this.findVariant(sku);
    if (!found || found.v.shipping_class === 'service') return null;
    if (this.logisticsDown) throw new ShopUnavailable('http_503');
    const slow = this.slowLogistics && ['bulky', 'litter'].includes(found.v.shipping_class);
    return {
      sku,
      shipping_class: found.v.shipping_class,
      estimated_seconds: slow ? 1200 : 4.5, // 和 partners 的預設一樣
      slow,
      in_stock: (this.stock.get(sku) ?? 0) > 0,
    };
  }

  async findCustomers(query: string, actor: Actor): Promise<CustomerHit[]> {
    this.hit('findCustomers', actor);
    const q = query.trim();
    if (q.length < 2 || /[%_\\]/.test(q)) return [];
    return this.customers
      .filter((c) => c.email.startsWith(q) || c.name.startsWith(q))
      .slice(0, 5)
      .map((c) => ({ id: c.id, name: c.name, email: c.email.replace(/^(.{2})[^@]*/, '$1***') }));
  }

  private owned(customerId: number, orderNo: string) {
    const s = this.orderStore.get(orderNo);
    return s && s.customerId === customerId ? s : null;
  }

  async orders(customerId: number, actor: Actor) {
    this.hit('orders', actor);
    return [...this.orderStore.values()]
      .filter((s) => s.customerId === customerId)
      .map(({ order: o }) => ({
        order_no: o.order_no,
        status: o.status,
        total: o.total,
        created_at: o.created_at,
        item_count: o.items.reduce((n, i) => n + i.qty, 0),
      }));
  }

  async order(customerId: number, orderNo: string, actor: Actor) {
    this.hit('order', actor);
    return this.owned(customerId, orderNo)?.order ?? null;
  }

  async shipments(customerId: number, orderNo: string, actor: Actor) {
    this.hit('shipments', actor);
    return this.owned(customerId, orderNo)?.shipments ?? null;
  }

  async refunds(customerId: number, orderNo: string, actor: Actor) {
    this.hit('refunds', actor);
    return this.owned(customerId, orderNo)?.refunds ?? null;
  }

  private policyView(s: StoredOrder) {
    return {
      payment_status: s.order.paid ? 'paid' : 'unpaid',
      total: s.order.total,
      shipping_fee: s.order.shipping_fee,
      refunded_amount: s.order.refunded_amount,
      items: s.order.items,
      delivered_at: s.shipments.map((x) => (x.delivered_at ? new Date(x.delivered_at) : null)),
    };
  }

  async refundPreview(customerId: number, orderNo: string, lines: RefundLines) {
    this.hit('refundPreview');
    const s = this.owned(customerId, orderNo);
    return s ? checkRefund(this.policyView(s), lines, this.now()) : null;
  }

  async requestRefund(
    customerId: number,
    orderNo: string,
    req: { lines: RefundLines; idempotencyKey: string; staffId: number; proposalId: string },
  ) {
    this.hit('requestRefund');
    const s = this.owned(customerId, orderNo);
    if (!s) return { status: 'rejected' as const, code: 'not_found' };
    const done = s.refunds.find((r) => (r as Refund & { key?: string }).key === req.idempotencyKey);
    if (done) return { status: 'accepted' as const, refundId: String(done.id), amount: done.amount };
    const check = checkRefund(this.policyView(s), req.lines, this.now());
    if (!check.eligible) return { status: 'rejected' as const, code: check.code };
    for (const [id, qty] of Object.entries(req.lines)) s.order.items.find((i) => i.id === Number(id))!.refunded_qty += qty;
    s.order.refunded_amount += check.amount;
    const refund = {
      id: this.nextRefundId++,
      amount: check.amount,
      status: 'PENDING',
      created_at: this.now().toISOString(),
      succeeded_at: this.now().toISOString(),
      items: Object.entries(req.lines).map(([id, qty]) => ({
        order_item_id: Number(id),
        qty,
        amount: s.order.items.find((i) => i.id === Number(id))!.unit_price * qty,
      })),
      key: req.idempotencyKey,
    };
    s.refunds.push(refund);
    return { status: 'accepted' as const, refundId: String(refund.id), amount: check.amount };
  }

  async refundStatus(refundId: string) {
    this.hit('refundStatus');
    for (const s of this.orderStore.values()) {
      const r = s.refunds.find((x) => String(x.id) === refundId);
      if (!r) continue;
      r.status = this.refundOutcome;
      const allBack = s.order.items.every((i) => i.refunded_qty >= i.qty);
      return {
        refund_id: r.id,
        status: this.refundOutcome,
        amount: r.amount,
        order_status: this.refundOutcome === 'SUCCEEDED' ? (allBack ? 'REFUNDED' : 'PARTIALLY_REFUNDED') : s.order.status,
      };
    }
    return null;
  }

  /** 測試用：一張訂單的明細 id，照建單順序 */
  itemIds(orderNo: string) {
    return this.orderStore.get(orderNo)!.order.items.map((i) => i.id);
  }

  /** 測試用：所有已成立的退款 */
  allRefunds() {
    return [...this.orderStore.values()].flatMap((s) =>
      s.refunds.map((r) => ({ order_no: s.order.order_no, amount: r.amount })),
    );
  }

  /** 測試用：建一張已付款的訂單；每種運送類別一個出貨單，deliveredAt 有給就算已送達 */
  createOrder(
    customerId: number,
    items: { sku: string; qty: number }[],
    opts: {
      orderNo: string;
      status?: keyof typeof STATUS;
      createdAt?: Date;
      deliveredAt?: Date | null;
      shippingFee?: number;
      paid?: boolean;
    },
  ) {
    const lines = items.map(({ sku, qty }) => {
      const { p, v } = this.findVariant(sku)!;
      return {
        id: this.nextItemId++,
        sku,
        name: DOCS.get(p.slug)!.name,
        flavor: v.flavor,
        size_label: v.size_label,
        qty,
        unit_price: v.price,
        refunded_qty: 0,
        fulfillment_type: 'direct',
        fulfillment_status: 'PROCESSING',
      };
    });
    const classOf = new Map(items.map(({ sku }, i) => [lines[i].id, this.findVariant(sku)!.v.shipping_class]));
    const subtotal = lines.reduce((n, l) => n + l.unit_price * l.qty, 0);
    const fee = opts.shippingFee ?? 0;
    const status = opts.status ?? 'delivered';
    const created = (opts.createdAt ?? this.now()).toISOString();
    // 沒指定送達時間：已送達的訂單算下單隔天送到（沒給下單時間就是昨天送到）
    const delivered =
      opts.deliveredAt !== undefined
        ? opts.deliveredAt
        : status === 'delivered'
          ? opts.createdAt
            ? new Date(opts.createdAt.getTime() + 86_400_000)
            : new Date(this.now().getTime() - 86_400_000)
          : null;
    const classes = [...new Set(classOf.values())];
    this.orderStore.set(opts.orderNo, {
      customerId,
      order: {
        order_no: opts.orderNo,
        status: STATUS[status],
        subtotal,
        shipping_fee: fee,
        total: subtotal + fee,
        paid: opts.paid ?? true,
        refunded_amount: 0,
        created_at: created,
        paid_at: created,
        items: lines,
      },
      shipments: classes.map((cls, i) => ({
        tracking_no: `TRK-${opts.orderNo}-${i + 1}`,
        carrier: cls === 'bulky' ? 'bulky_freight' : 'home_delivery',
        shipping_class: cls,
        status: delivered ? 'DELIVERED' : status === 'paid' ? 'REQUESTED' : 'IN_TRANSIT',
        events: delivered ? [{ status: 'DELIVERED', at: delivered.toISOString() }] : [],
        delivered_at: delivered ? delivered.toISOString() : null,
        order_item_ids: lines.filter((l) => classOf.get(l.id) === cls).map((l) => l.id),
      })),
      refunds: [],
    });
  }
}

/** 所有 e2e 測試共用一個；startApp 預設注入它，shopFixture 每次重設 */
export const fakeShop = new FakeShop();
