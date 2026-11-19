import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Actor,
  CustomerHit,
  DeliveryEstimate,
  FeedingRow,
  Order,
  OrderSummary,
  ProductDoc,
  ProductIndexEntry,
  ProductSpec,
  Refund,
  RefundLines,
  RefundPreview,
  RefundRequestResult,
  RefundState,
  Shipment,
  ShopClient,
  VariantSummary,
} from './shop-client.js';
import { ShopUnavailable } from './shop-client.js';

const TIMEOUT_MS = 3000;

/**
 * 呼叫 core-api 的 /api/v1/internal/support/*（AIC-013），帶 support 自己的服務金鑰。
 * 每個呼叫 3 秒逾時、不重試（AC-43）：讀取慢就轉真人，不讓客戶乾等。
 * 404 → null（不存在或不是這位客戶的，core-api 不分）；其他錯誤 → ShopUnavailable
 */
export class CoreApiShopClient implements ShopClient {
  private readonly logger = new Logger('shop');

  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
  ) {
    if (!baseUrl || !key) throw new Error('缺少 CORE_API_URL 或 SUPPORT_SERVICE_KEY');
  }

  private async send(path: string, actor: Actor, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/api/v1/internal/support/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/json',
          'x-service-key': this.key,
          'x-support-actor': actor,
          'x-correlation-id': randomUUID(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ShopUnavailable(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network');
    }
  }

  private async get<T>(path: string, actor: Actor = 'anonymous', body?: unknown): Promise<T | null> {
    const res = await this.send(path, actor, body);
    if (res.status === 404) return null;
    if (!res.ok) {
      // 不記路徑：裡面有訂單號
      if (res.status === 401) this.logger.warn('core-api 拒絕了 support 的服務金鑰');
      throw new ShopUnavailable(`http_${res.status}`);
    }
    return ((await res.json()) as { data: T }).data;
  }

  async productIndex() {
    return (await this.get<ProductIndexEntry[]>('products')) ?? [];
  }

  productDoc(slug: string) {
    return this.get<ProductDoc>(`products/${encodeURIComponent(slug)}`);
  }

  async feeding(slug: string) {
    const doc = await this.get<{ feeding: FeedingRow[] }>(`products/${encodeURIComponent(slug)}`);
    return doc ? doc.feeding : null;
  }

  variants(slug: string) {
    return this.get<VariantSummary[]>(`products/${encodeURIComponent(slug)}/variants`);
  }

  variant(sku: string) {
    return this.get<ProductSpec>(`variants/${encodeURIComponent(sku)}`);
  }

  deliveryEstimate(sku: string) {
    return this.get<DeliveryEstimate>(`variants/${encodeURIComponent(sku)}/delivery-estimate`);
  }

  async findCustomers(query: string, actor: Actor) {
    // 太短的查詢 core-api 回 422；這裡先擋，不浪費一次呼叫
    if (query.trim().length < 2 || /[%_\\]/.test(query)) return [];
    return (await this.get<CustomerHit[]>(`customers?query=${encodeURIComponent(query.trim())}`, actor)) ?? [];
  }

  async orders(customerId: number, actor: Actor) {
    return (await this.get<OrderSummary[]>(`customers/${customerId}/orders`, actor)) ?? [];
  }

  order(customerId: number, orderNo: string, actor: Actor) {
    return this.get<Order>(`customers/${customerId}/orders/${encodeURIComponent(orderNo)}`, actor);
  }

  shipments(customerId: number, orderNo: string, actor: Actor) {
    return this.get<Shipment[]>(`customers/${customerId}/orders/${encodeURIComponent(orderNo)}/shipments`, actor);
  }

  refunds(customerId: number, orderNo: string, actor: Actor) {
    return this.get<Refund[]>(`customers/${customerId}/orders/${encodeURIComponent(orderNo)}/refunds`, actor);
  }

  // 退款（AIC-016）：預覽只算不寫；申請過 core-api 的退款政策，接受後是 PENDING，要等金流
  async refundPreview(customerId: number, orderNo: string, lines: RefundLines): Promise<RefundPreview | null> {
    const r = await this.get<{ eligible: boolean; code: string | null; amount: number }>(
      `customers/${customerId}/orders/${encodeURIComponent(orderNo)}/refund-preview`,
      'anonymous',
      { lines },
    );
    if (!r) return null;
    return r.eligible ? { eligible: true, amount: r.amount } : { eligible: false, code: r.code ?? 'rejected', amount: r.amount };
  }

  async requestRefund(
    customerId: number,
    orderNo: string,
    req: { lines: RefundLines; idempotencyKey: string; staffId: number; proposalId: string },
  ): Promise<RefundRequestResult> {
    const res = await this.send(`customers/${customerId}/orders/${encodeURIComponent(orderNo)}/refunds`, `staff:${req.staffId}`, {
      lines: req.lines,
      idempotency_key: req.idempotencyKey,
      staff_id: req.staffId,
      proposal_id: req.proposalId,
    });
    if (res.status === 202 || res.status === 200) {
      const { data } = (await res.json()) as { data: { refund_id: number; amount: number } };
      return { status: 'accepted', refundId: String(data.refund_id), amount: data.amount };
    }
    // 409：商店的規則擋下（超過期限、數量不足…）；404：不是這位客戶的訂單
    if (res.status === 409 || res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { status: 'rejected', code: res.status === 404 ? 'not_found' : (body.error ?? 'rejected') };
    }
    throw new ShopUnavailable(`http_${res.status}`);
  }

  refundStatus(refundId: string) {
    return this.get<RefundState>(`refunds/${encodeURIComponent(refundId)}`);
  }
}
