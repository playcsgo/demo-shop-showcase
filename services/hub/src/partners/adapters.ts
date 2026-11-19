import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PartnerHttp } from '../common/resilience/partner-http.js';

/**
 * Adapter（port／adapter 的 adapter）：把「外部廠商的 API」包成我們自己的方法。
 * 換廠商（例如 TapPay → 綠界）只要換 adapter，core 和 hub 的其他部分都不用改。
 */
@Injectable()
export class PaymentAdapter {
  readonly http: PartnerHttp;
  constructor(config: ConfigService) {
    this.http = new PartnerHttp('mockpay', `${config.get('PARTNERS_URL', 'http://partners:4000')}/mockpay/v1`);
  }

  /** capture: 'manual' → 只授權，之後 capture() 才請款（預約用，§6.4.1） */
  charge(input: { order_no: string; amount: number; idempotency_key: string; merchant_id: string; payment_token_ref?: string; capture?: 'manual' }) {
    return this.http.request<{ charge_id: string; status: string }>('POST', '/charges', input);
  }

  capture(chargeId: string) {
    return this.http.request<{ charge_id: string; status: string; amount: number }>('POST', `/charges/${encodeURIComponent(chargeId)}/capture`);
  }

  void(chargeId: string) {
    return this.http.request<{ charge_id: string; status: string }>('POST', `/charges/${encodeURIComponent(chargeId)}/void`);
  }

  findByOrder(orderNo: string) {
    return this.http.request<{ charge_id: string; status: string; amount: number }>('GET', `/charges?order_no=${encodeURIComponent(orderNo)}`);
  }

  refund(input: { charge_id: string; amount: number; idempotency_key: string; refund_id: number }) {
    return this.http.request<{ refund_id: string }>('POST', '/refunds', input);
  }
}

@Injectable()
export class LogisticsAdapter {
  readonly http: PartnerHttp;
  constructor(config: ConfigService) {
    this.http = new PartnerHttp('mocklogi', `${config.get('PARTNERS_URL', 'http://partners:4000')}/mocklogi/v1`);
  }

  // shipping_class：物流商要分得出貨砂和一般商品（兩個都是 home_delivery），大型物流 demo 才能只放慢它們（AIC-017）
  createShipment(input: { shipment_id: number; carrier: string; shipping_class?: string; items: unknown[] }) {
    return this.http.request<{ tracking_no: string }>('POST', '/shipments', input);
  }

  /** 物流商的預估送達時間（AIC-017）：core-api 同步來問 */
  estimate(shippingClass: string) {
    return this.http.request<{ shipping_class: string; estimated_seconds: number; slow: boolean }>(
      'GET',
      `/estimate?shipping_class=${encodeURIComponent(shippingClass)}`,
    );
  }
}

/**
 * 寵物醫院（TCC，§6.4.1）：
 *  - 保留：顧客在畫面上等結果 → 同步、逾時短、最多試 2 次（sync）
 *  - 確認、釋放：在背景由 SQS 指令觸發 → 一般的重試設定（http）
 * 兩組各有自己的斷路器：背景確認一直失敗，不會讓前台連空位都查不到。
 */
@Injectable()
export class ClinicAdapter {
  readonly http: PartnerHttp;
  readonly sync: PartnerHttp;
  constructor(config: ConfigService) {
    const base = `${config.get('PARTNERS_URL', 'http://partners:4000')}/mockvet/v1`;
    this.http = new PartnerHttp('mockvet', base);
    this.sync = new PartnerHttp('mockvet-sync', base, { timeoutMs: 2500, attempts: 2, baseDelayMs: 100 });
  }

  hold(input: { hold_key: string; start_at: string; service_type: string }) {
    return this.sync.request<{ hold_id: string; expires_at: string }>('POST', '/holds', input);
  }

  confirm(holdId: string, bookingId: number) {
    return this.http.request<{ provider_booking_id: string; status: string }>('POST', `/holds/${encodeURIComponent(holdId)}/confirm`, { booking_id: bookingId });
  }

  release(holdId: string) {
    return this.http.request('DELETE', `/holds/${encodeURIComponent(holdId)}`);
  }
}

@Injectable()
export class LineAdapter {
  readonly http: PartnerHttp;
  constructor(config: ConfigService) {
    // 通知是 best-effort：只試 1 次、逾時短，失敗不影響主流程
    this.http = new PartnerHttp('mockline', `${config.get('PARTNERS_URL', 'http://partners:4000')}/mockline/v1`, { timeoutMs: 2000, attempts: 1, baseDelayMs: 0 });
  }

  push(to: string, message: string) {
    return this.http.request('POST', '/push', { to, message });
  }
}
