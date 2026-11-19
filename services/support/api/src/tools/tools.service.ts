import { Inject, Injectable, Logger } from '@nestjs/common';
import { ToolCallLog } from '../audit/tool-call-log.js';
import {
  type Actor,
  SHOP_CLIENT,
  ShopUnavailable,
  type ShopClient,
} from '../shop/index.js';
import { SopBook } from '../sop/sop.js';
import type { RunContext, ToolRole } from './run-token.service.js';

type Args = Record<string, unknown>;
type Outcome =
  | {
      status: 'ok';
      result: Record<string, unknown>;
      refs?: [string, unknown][];
    }
  | { status: 'not_found' | 'invalid' | 'denied' }
  | { status: 'shop_down' }; // 商店或物流商掛了、逾時（AC-43）：回明確的錯誤，模型不能自己編時間，轉真人

/** propose_action 的參數；伺服器驗證過才交給 ProposalService */
export interface ProposeArgs {
  type: 'refund';
  order_no: string;
  lines: { item_id: number; qty: number }[];
  judgment: string;
  reason: string;
  refs?: string[];
}

export type ToolSignal =
  { type: 'login' } | { type: 'transfer'; queue: 'cs' | 'vet'; reason: string };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  roles: ToolRole[];
  run: (ctx: RunContext, args: Args) => Promise<Outcome>;
}

const ALL: ToolRole[] = ['anonymous', 'customer', 'agent', 'join'];
const stockOf = (spec: { sku: string; available: number | null; in_stock: boolean } | null) =>
  spec && { sku: spec.sku, available: spec.available, in_stock: spec.in_stock };
const SLUG = /^[a-z0-9-]{1,60}$/;
const SKU = /^[A-Z0-9-]{3,60}$/;
const ORDER_NO = /^[A-Z0-9-]{1,20}$/;
const str = (args: Args, key: string, pattern: RegExp) => {
  const v = args[key];
  return typeof v === 'string' && pattern.test(v) ? v : null;
};
const schema = (
  props: Record<string, { type: string; description: string; enum?: string[] }>,
) => ({
  type: 'object',
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});

/**
 * 白名單工具。模型只能選工具、傳參數；客戶 ID 一律來自 run token，參數裡帶的會被忽略。
 * 每次呼叫都留紀錄，回傳的資料登記成這次執行可以引用的來源
 */
@Injectable()
export class ToolsService {
  private readonly logger = new Logger('tools');
  private readonly refs = new Map<string, Map<string, unknown>>();
  private readonly runSignals = new Map<string, ToolSignal[]>();
  private readonly warnings = new Map<
    string,
    { slug: string; name: string; warnings: string[] }[]
  >();
  private readonly warned = new Map<string, Set<string>>();
  private readonly defs: ToolDef[];
  private proposer:
    ((ctx: RunContext, args: ProposeArgs) => Promise<unknown>) | null = null;

  constructor(
    @Inject(ToolCallLog) private readonly log: ToolCallLog,
    @Inject(SHOP_CLIENT) private readonly shop: ShopClient,
    @Inject(SopBook) private readonly sops: SopBook,
  ) {
    this.defs = this.define();
  }

  /** ProposalService 啟動時掛上來：AI 層只拿得到「建立提案」，拿不到「執行」 */
  setProposer(fn: (ctx: RunContext, args: ProposeArgs) => Promise<unknown>) {
    this.proposer = fn;
  }

  listFor(role: ToolRole) {
    return this.defs
      .filter((d) => d.roles.includes(role))
      .map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
  }

  async call(
    ctx: RunContext,
    name: string,
    rawArgs: unknown,
  ): Promise<{ content: string; isError: boolean }> {
    const started = Date.now();
    const args = (
      rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
    ) as Args;
    const def = this.defs.find((d) => d.name === name);
    let outcome: Outcome | { status: 'error' };
    try {
      outcome =
        def && def.roles.includes(ctx.role)
          ? await def.run(ctx, args)
          : { status: 'denied' };
    } catch (err) {
      if (err instanceof ShopUnavailable) {
        this.logger.warn(`${ctx.runId} 工具 ${name}：商店無法使用（${err.reason}）`);
        outcome = { status: 'shop_down' };
      } else {
        this.logger.error(`${ctx.runId} 工具 ${name} 執行失敗`); // 不記參數和錯誤細節
        outcome = { status: 'error' };
      }
    }
    const result =
      outcome.status === 'ok'
        ? outcome.result
        : {
            error:
              outcome.status === 'shop_down'
                ? 'shop_unavailable'
                : outcome.status,
          };
    if (outcome.status === 'ok') {
      const registry = this.refs.get(ctx.runId) ?? new Map<string, unknown>();
      for (const [key, data] of outcome.refs ?? []) registry.set(key, data);
      this.refs.set(ctx.runId, registry);
    }
    await this.log.record({
      runId: ctx.runId,
      tool: name,
      agentId: ctx.agentId,
      args,
      result,
      status: outcome.status,
      durationMs: Date.now() - started,
    });
    return {
      content: JSON.stringify(result),
      isError: outcome.status !== 'ok',
    };
  }

  /** 引用只能指向這次執行工具真的回傳過的資料 */
  refLookup(runId: string) {
    // 每次查詢時才找：解析器在工具被呼叫之前就建立了
    return (key: string) => this.refs.get(runId)?.get(key);
  }

  signals(runId: string): ToolSignal[] {
    return this.runSignals.get(runId) ?? [];
  }

  /**
   * AC-21：讀過商品全文就記下警示，Ask 立刻顯示在回答前面。警示來自商品資料、由伺服器產生，
   * 模型漏寫也不會消失。同一個商品在一次執行裡只顯示一次
   */
  drainWarnings(runId: string) {
    const out = this.warnings.get(runId) ?? [];
    this.warnings.delete(runId);
    return out;
  }

  forget(runId: string) {
    this.refs.delete(runId);
    this.runSignals.delete(runId);
    this.warnings.delete(runId);
    this.warned.delete(runId);
  }

  private noteWarnings(
    runId: string,
    doc: { slug: string; name: string; warnings: string[] },
  ) {
    const seen = this.warned.get(runId) ?? new Set<string>();
    if (seen.has(doc.slug)) return;
    seen.add(doc.slug);
    this.warned.set(runId, seen);
    this.warnings.set(runId, [
      ...(this.warnings.get(runId) ?? []),
      { slug: doc.slug, name: doc.name, warnings: doc.warnings },
    ]);
  }

  /** 已退款、還能退多少；金額照明細算，運費不退（和 core-api 的退款規則一致） */
  private async refundStatus(customerId: number, orderNo: string, who: Actor) {
    const order = await this.shop.order(customerId, orderNo, who);
    if (!order) return null;
    return {
      order_no: order.order_no,
      order_status: order.status,
      refunded_amount: order.refunded_amount,
      refundable_amount: order.total - order.shipping_fee - order.refunded_amount,
      refunds: (await this.shop.refunds(customerId, orderNo, who)) ?? [],
    };
  }

  private signal(ctx: RunContext, s: ToolSignal) {
    this.runSignals.set(ctx.runId, [...this.signals(ctx.runId), s]);
  }

  private define(): ToolDef[] {
    const withRef = (key: string, field: string, value: unknown): Outcome =>
      value === null || value === undefined
        ? { status: 'not_found' }
        : {
            status: 'ok',
            result: { [field]: value, ref: key },
            refs: [[key, value]],
          };
    // 客服查的是目前對話的客戶；對話沒有客戶就查不到
    const customer = (ctx: RunContext) =>
      ctx.role === 'anonymous' ? null : ctx.customerId;
    // 這次替誰查：core-api 記進 log
    const actor = (ctx: RunContext): Actor =>
      ctx.agentId
        ? `staff:${ctx.agentId}`
        : ctx.customerId
          ? `customer:${ctx.customerId}`
          : 'anonymous';

    return [
      {
        name: 'get_product_doc',
        description:
          '讀一個商品的介紹、適用情境、成分、注意事項和不適用警示。slug 從系統提示的商品索引挑',
        inputSchema: schema({
          slug: { type: 'string', description: '商品 slug' },
        }),
        roles: ALL,
        run: async (_c, a) => {
          const slug = str(a, 'slug', SLUG);
          if (!slug) return { status: 'invalid' };
          const doc = await this.shop.productDoc(slug);
          if (doc) this.noteWarnings(_c.runId, doc);
          return withRef(`product_doc:${slug}`, 'doc', doc);
        },
      },
      {
        name: 'list_variants',
        description: '列出一個商品所有口味和規格的 SKU、價格、是否有貨',
        inputSchema: schema({
          slug: { type: 'string', description: '商品 slug' },
        }),
        roles: ALL,
        run: async (_c, a) => {
          const slug = str(a, 'slug', SLUG);
          if (!slug) return { status: 'invalid' };
          const variants = await this.shop.variants(slug);
          return withRef(
            `variants:${slug}`,
            'variants',
            variants?.length ? variants : null,
          );
        },
      },
      {
        name: 'get_product_spec',
        description:
          '查一個 SKU 的價格、重量、尺寸、保存期限、保存方式、包裝。沒有資料的欄位是 null',
        inputSchema: schema({
          sku: { type: 'string', description: 'SKU，例如 DCS-CAN-DUCK-80' },
        }),
        roles: ALL,
        run: async (_c, a) => {
          const sku = str(a, 'sku', SKU);
          return sku
            ? withRef(`sku:${sku}`, 'spec', await this.shop.variant(sku))
            : { status: 'invalid' };
        },
      },
      {
        name: 'get_stock',
        description: '查一個 SKU 現在有沒有貨',
        inputSchema: schema({ sku: { type: 'string', description: 'SKU' } }),
        roles: ALL,
        run: async (_c, a) => {
          const sku = str(a, 'sku', SKU);
          return sku
            ? withRef(`stock:${sku}`, 'stock', stockOf(await this.shop.variant(sku)))
            : { status: 'invalid' };
        },
      },
      {
        name: 'get_feeding_guide',
        description: '查一個商品依體重的每日建議份量',
        inputSchema: schema({
          slug: { type: 'string', description: '商品 slug' },
        }),
        roles: ALL,
        run: async (_c, a) => {
          const slug = str(a, 'slug', SLUG);
          if (!slug) return { status: 'invalid' };
          const guide = await this.shop.feeding(slug);
          return withRef(
            `feeding:${slug}`,
            'feeding_guide',
            guide?.length ? guide : null,
          );
        },
      },
      {
        name: 'list_orders',
        description: '列出這位客戶最近的訂單',
        inputSchema: schema({}),
        roles: ['customer', 'agent', 'join'],
        run: async (c) => {
          const id = customer(c);
          return id
            ? withRef('orders:list', 'orders', await this.shop.orders(id, actor(c)))
            : { status: 'not_found' };
        },
      },
      {
        name: 'get_order',
        description: '查這位客戶的一張訂單：狀態、明細、金額',
        inputSchema: schema({
          order_no: { type: 'string', description: '訂單編號' },
        }),
        roles: ['customer', 'agent', 'join'],
        run: async (c, a) => {
          const no = str(a, 'order_no', ORDER_NO);
          if (!no) return { status: 'invalid' };
          const id = customer(c);
          return id
            ? withRef(
                `order:${no}`,
                'order',
                await this.shop.order(id, no, actor(c)),
              )
            : { status: 'not_found' };
        },
      },
      {
        name: 'get_refund_status',
        description: '查這位客戶一張訂單的退款紀錄、已退款和可退款的金額',
        inputSchema: schema({
          order_no: { type: 'string', description: '訂單編號' },
        }),
        roles: ['customer', 'agent', 'join'],
        run: async (c, a) => {
          const no = str(a, 'order_no', ORDER_NO);
          if (!no) return { status: 'invalid' };
          const id = customer(c);
          return id
            ? withRef(
                `refund:${no}`,
                'refund',
                await this.refundStatus(id, no, actor(c)),
              )
            : { status: 'not_found' };
        },
      },
      {
        name: 'estimate_delivery',
        description:
          '預估一個 SKU 從下單到送達要多久（秒）。時間由物流商提供，照實轉述，不要自己估；查不到就轉真人',
        inputSchema: schema({ sku: { type: 'string', description: 'SKU' } }),
        roles: ALL,
        run: async (_c, a) => {
          const sku = str(a, 'sku', SKU);
          if (!sku) return { status: 'invalid' };
          // 物流商的預估（AIC-017）：core-api 經 hub 問 partners；物流商掛了 → shop_unavailable
          return withRef(`estimate:${sku}`, 'estimate', await this.shop.deliveryEstimate(sku));
        },
      },
      {
        name: 'track_shipment',
        description: '查這位客戶一張訂單的包裹到哪了、下一站和預計時間',
        inputSchema: schema({
          order_no: { type: 'string', description: '訂單編號' },
        }),
        roles: ['customer', 'agent', 'join'],
        run: async (c, a) => {
          const no = str(a, 'order_no', ORDER_NO);
          if (!no) return { status: 'invalid' };
          const id = customer(c);
          return id
            ? withRef(
                `shipment:${no}`,
                'shipments',
                await this.shop.shipments(id, no, actor(c)),
              )
            : { status: 'not_found' };
        },
      },
      {
        name: 'get_sop',
        description:
          '讀一份客服 SOP（refund、shipping、recommendation、medical、privacy）。判斷要引用條目，例如 [[ref:sop:refund#E2]]',
        inputSchema: schema({
          topic: { type: 'string', description: 'SOP 主題' },
        }),
        roles: ALL,
        run: async (_c, a) => {
          const topic = str(a, 'topic', /^[a-z]{1,30}$/);
          if (!topic) return { status: 'invalid' };
          const sop = this.sops.get(topic);
          if (!sop) return { status: 'not_found' };
          const clauses = [...sop.steps, ...sop.exceptions].map(
            (c) => [`sop:${topic}#${c.id}`, c] as [string, unknown],
          );
          return {
            status: 'ok',
            result: { sop, ref: `sop:${topic}` },
            refs: [[`sop:${topic}`, sop], ...clauses],
          };
        },
      },
      {
        name: 'propose_action',
        description:
          '客服用：提出退款提案，給客服核准。金額由系統依明細算，不用填。要附上判斷、原因和引用的 SOP 條目',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['refund'] },
            order_no: { type: 'string', description: '訂單編號' },
            lines: {
              type: 'array',
              description: '要退的明細：get_order 回傳的 items[].id 和數量',
              items: {
                type: 'object',
                properties: {
                  item_id: { type: 'integer' },
                  qty: { type: 'integer' },
                },
                required: ['item_id', 'qty'],
              },
            },
            judgment: { type: 'string', description: '可不可以退，一句話' },
            reason: { type: 'string', description: '原因' },
            refs: {
              type: 'array',
              items: { type: 'string' },
              description: '引用，例如 sop:refund#S2',
            },
          },
          required: ['type', 'order_no', 'lines', 'judgment', 'reason'],
          additionalProperties: false,
        },
        roles: ['agent', 'join'],
        run: async (c, a) => {
          const no = str(a, 'order_no', ORDER_NO);
          const lines = Array.isArray(a.lines)
            ? a.lines
                .filter(
                  (l): l is { item_id: number; qty: number } =>
                    Number.isInteger(l?.item_id) &&
                    Number.isInteger(l?.qty) &&
                    l.qty > 0,
                )
                .slice(0, 50)
            : [];
          const text = (k: string) =>
            typeof a[k] === 'string' && (a[k] as string).length <= 500
              ? (a[k] as string)
              : null;
          const judgment = text('judgment');
          const reason = text('reason');
          if (
            a.type !== 'refund' ||
            !no ||
            !lines.length ||
            !judgment ||
            !reason ||
            !this.proposer
          )
            return { status: 'invalid' };
          const refs = Array.isArray(a.refs)
            ? a.refs
                .filter((r): r is string => typeof r === 'string')
                .slice(0, 20)
            : [];
          // 金額欄位就算模型填了也不傳：卡片上的金額由 shop 算
          const proposal = await this.proposer(c, {
            type: 'refund',
            order_no: no,
            lines,
            judgment,
            reason,
            refs,
          });
          return proposal
            ? { status: 'ok', result: { proposal } }
            : { status: 'not_found' };
        },
      },
      {
        name: 'find_customer',
        description: '客服用：用名稱或 email 開頭找客戶，只回遮罩後的資料',
        inputSchema: schema({
          query: { type: 'string', description: '名稱或 email 的開頭' },
        }),
        roles: ['agent'],
        run: async (c, a) => {
          const q =
            typeof a.query === 'string' && a.query.length <= 50
              ? a.query
              : null;
          if (!q) return { status: 'invalid' };
          const found = await this.shop.findCustomers(q, actor(c));
          return {
            status: 'ok',
            result: { customers: found },
            refs: found.map(
              (f) => [`customer:${f.id}`, f] as [string, unknown],
            ),
          };
        },
      },
      {
        name: 'request_login',
        description:
          '客戶沒登入卻問到自己的訂單時呼叫，畫面會出現登入按鈕。不要自己查訂單',
        inputSchema: schema({}),
        roles: ['anonymous'],
        run: async (c) => {
          this.signal(c, { type: 'login' });
          return { status: 'ok', result: { shown: true } };
        },
      },
      {
        name: 'transfer',
        description:
          '沒把握、查不到、客戶要退款或取消、想找真人時呼叫，直接轉給真人，不要先問客戶',
        inputSchema: schema({
          queue: {
            type: 'string',
            description: 'cs＝客服，vet＝獸醫',
            enum: ['cs', 'vet'],
          },
          reason: { type: 'string', description: '一句話，只給客服看' },
        }),
        roles: ['anonymous', 'customer'],
        run: async (c, a) => {
          const queue = a.queue === 'cs' || a.queue === 'vet' ? a.queue : null;
          const reason =
            typeof a.reason === 'string' && a.reason.length <= 200
              ? a.reason
              : null;
          if (!queue || !reason) return { status: 'invalid' };
          this.signal(c, { type: 'transfer', queue, reason });
          return { status: 'ok', result: { transferred: true } };
        },
      },
    ];
  }
}
