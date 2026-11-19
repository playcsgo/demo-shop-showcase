import type { FastifyInstance, FastifyRequest } from 'fastify';
import { estimate, stepMsFor } from './logistics.js';
import { randomUUID } from 'node:crypto';
import { dice, scaled } from './dice.js';
import { record } from './events.js';
import { applyFaults, settings, sleep } from './faults.js';
import { sendWebhook } from './webhook.js';

// hub 帶來的 correlation_id：記 log、決定要不要注入故障都用它（見 dice.ts）
const corr = (req: FastifyRequest) => String(req.headers['x-correlation-id'] ?? '');

// capture: 'manual'＝先授權、之後才請款（預約用，§6.4.1）；預設是授權＋請款一次完成
interface Charge {
  charge_id: string; order_no: string; amount: number; capture: 'auto' | 'manual'; refunded: number;
  status: 'processing' | 'authorized' | 'succeeded' | 'voided' | 'failed';
}
const charges = new Map<string, Charge>();      // charge_id → charge
const chargeByKey = new Map<string, string>();  // idempotency_key → charge_id
const refundsByKey = new Map<string, string>();

// 假醫院的保留（TCC 的 Try／Confirm／Cancel）：不模擬時段庫存，額滿由控制台的「額滿率」決定
interface Hold {
  hold_id: string; hold_key: string; start_at: string; expires_at: number;
  status: 'held' | 'confirmed' | 'released' | 'expired'; provider_booking_id?: string;
}
const holds = new Map<string, Hold>();         // hold_id → hold
const holdByKey = new Map<string, string>();   // hold_key → hold_id

/**
 * demo 用（AIC-016）：登記一筆「已經付款成功」的扣款，不送任何 callback。
 * 給直接寫進資料庫的 demo 訂單（core-api 的 support:demo-orders）用：不登記的話，退款時這裡會說找不到這筆扣款。
 * 同一個 charge_id 再登記一次只更新金額（partners 重啟後 demo 重跑也沒問題）
 */
export function seedCharge(input: { charge_id: string; order_no: string; amount: number }): Charge {
  const prev = charges.get(input.charge_id);
  const charge: Charge = { ...input, capture: 'auto', refunded: prev?.refunded ?? 0, status: 'succeeded' };
  charges.set(charge.charge_id, charge);
  return charge;
}

/** sandbox 每個情境開始前清空（不用重啟容器） */
export function resetPartnersState(): void {
  for (const m of [charges, chargeByKey, refundsByKey, holds, holdByKey]) m.clear();
}

// 醫院自己的規則：保留過期就釋放（不靠我們通知）
setInterval(() => {
  for (const h of holds.values()) {
    if (h.status === 'held' && h.expires_at < Date.now()) { h.status = 'expired'; record('mockvet', 'hold.expired', `${h.hold_id} ${h.start_at}`); }
  }
}, 1000).unref();

export function registerPartners(app: FastifyInstance): void {
  // ───────── 假金流（類 TapPay）─────────
  app.post<{ Body: { order_no: string; amount: number; idempotency_key: string; capture?: 'manual' } }>('/mockpay/v1/charges', async (req, reply) => {
    const d = dice(corr(req), 'mockpay.charge');
    const ctx = { correlation_id: d.correlationId || undefined, order_no: req.body.order_no };
    const fault = await applyFaults(settings.payment, d);
    if (fault) { record('mockpay', `fault.${fault.status}`, req.body.order_no, ctx); return reply.code(fault.status).send(fault.body); }

    // 冪等：同一個 key 回同一筆，不重複扣款
    const existing = chargeByKey.get(req.body.idempotency_key);
    if (existing) { record('mockpay', 'charge.idempotent_replay', req.body.order_no, ctx); return reply.code(200).send(charges.get(existing)); }

    const capture = req.body.capture === 'manual' ? 'manual' : 'auto';
    const charge: Charge = { charge_id: `ch_${randomUUID().slice(0, 12)}`, order_no: req.body.order_no, amount: req.body.amount, capture, status: 'processing', refunded: 0 };
    charges.set(charge.charge_id, charge);
    chargeByKey.set(req.body.idempotency_key, charge.charge_id);
    record('mockpay', capture === 'manual' ? 'authorization.created' : 'charge.created', `${charge.order_no} $${charge.amount}`, ctx);

    void (async () => {
      await sleep(scaled(settings.payment.callbackDelayMs));
      const declined = d.hit('decline', settings.payment.declineRate);
      charge.status = declined ? 'failed' : capture === 'manual' ? 'authorized' : 'succeeded';
      if (d.hit('drop_callback', settings.payment.dropCallbackRate)) { record('mockpay', 'webhook.dropped', charge.order_no, ctx); return; }
      await sendWebhook('mockpay', {
        type: declined ? 'charge.failed' : capture === 'manual' ? 'charge.authorized' : 'charge.succeeded',
        charge_id: charge.charge_id, order_no: charge.order_no, amount: charge.amount,
        ...(declined ? { reason: 'card_declined' } : {}),
      }, d.hit('duplicate_callback', settings.payment.duplicateRate) ? 2 : 1);
    })();

    return reply.code(202).send(charge);
  });

  // 請款：授權過的才能請；重複呼叫回同一個結果（冪等）
  app.post<{ Params: { id: string } }>('/mockpay/v1/charges/:id/capture', async (req, reply) => {
    const d = dice(corr(req), 'mockpay.capture');
    const fault = await applyFaults(settings.payment, d);
    if (fault) { record('mockpay', `fault.${fault.status}`, 'capture', { correlation_id: d.correlationId || undefined }); return reply.code(fault.status).send(fault.body); }
    const c = charges.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (c.status === 'succeeded') return c;
    if (c.status !== 'authorized') return reply.code(409).send({ error: `cannot_capture_${c.status}` });
    c.status = 'succeeded';
    record('mockpay', 'capture', `${c.order_no} $${c.amount}`, { correlation_id: d.correlationId || undefined, order_no: c.order_no });
    return c;
  });

  // 取消授權：額度釋放，客人帳單上不會有這筆
  app.post<{ Params: { id: string } }>('/mockpay/v1/charges/:id/void', async (req, reply) => {
    const d = dice(corr(req), 'mockpay.void');
    const fault = await applyFaults(settings.payment, d);
    if (fault) { record('mockpay', `fault.${fault.status}`, 'void', { correlation_id: d.correlationId || undefined }); return reply.code(fault.status).send(fault.body); }
    const c = charges.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (c.status === 'voided') return c;
    if (c.status !== 'authorized') return reply.code(409).send({ error: `cannot_void_${c.status}` });
    c.status = 'voided';
    record('mockpay', 'void', `${c.order_no} $${c.amount}`, { correlation_id: d.correlationId || undefined, order_no: c.order_no });
    return c;
  });

  // 對帳用：主動查詢付款狀態（webhook 沒來時）
  app.get<{ Querystring: { order_no: string } }>('/mockpay/v1/charges', async (req, reply) => {
    const fault = await applyFaults(settings.payment, dice(corr(req), 'mockpay.query'));
    if (fault) return reply.code(fault.status).send(fault.body);
    const found = [...charges.values()].find((c) => c.order_no === req.query.order_no);
    record('mockpay', 'charge.queried', `${req.query.order_no} → ${found?.status ?? 'not_found'}`);
    return found ? found : reply.code(404).send({ error: 'not_found' });
  });

  app.post<{ Body: { charge_id: string; amount: number; idempotency_key: string; refund_id: number } }>('/mockpay/v1/refunds', async (req, reply) => {
    const d = dice(corr(req), 'mockpay.refund');
    const fault = await applyFaults(settings.payment, d);
    if (fault) { record('mockpay', `fault.${fault.status}`, 'refund', { correlation_id: d.correlationId || undefined }); return reply.code(fault.status).send(fault.body); }

    const existing = refundsByKey.get(req.body.idempotency_key);
    if (existing) return reply.code(200).send({ refund_id: existing, status: 'processing' });

    const charge = charges.get(req.body.charge_id);
    if (!charge || charge.refunded + req.body.amount > charge.amount) return reply.code(422).send({ error: 'invalid_refund' });
    charge.refunded += req.body.amount;
    const providerRefundId = `rf_${randomUUID().slice(0, 12)}`;
    refundsByKey.set(req.body.idempotency_key, providerRefundId);
    record('mockpay', 'refund.created', `${charge.order_no} $${req.body.amount}`, { correlation_id: d.correlationId || undefined, order_no: charge.order_no });

    void (async () => {
      await sleep(scaled(settings.payment.callbackDelayMs));
      await sendWebhook('mockpay', { type: 'refund.succeeded', refund_id: req.body.refund_id, provider_refund_id: providerRefundId, amount: req.body.amount },
        d.hit('duplicate_callback', settings.payment.duplicateRate) ? 2 : 1);
    })();

    return reply.code(202).send({ refund_id: providerRefundId, status: 'processing' });
  });

  // ───────── 假物流（類黑貓；大型物流共用）─────────
  // 預估送達時間（AIC-017）：core-api 經 hub 來問，AI 客服回答「多久會到」用
  app.get<{ Querystring: { shipping_class?: string } }>('/mocklogi/v1/estimate', async (req, reply) => {
    const d = dice(corr(req), 'mocklogi.estimate');
    const fault = await applyFaults(settings.logistics, d);
    if (fault) return reply.code(fault.status).send(fault.body);
    const cls = req.query.shipping_class;
    if (!cls || !['standard', 'litter', 'bulky'].includes(cls)) return reply.code(422).send({ error: 'invalid_shipping_class' });
    return estimate(cls);
  });

  app.post<{ Body: { shipment_id: number; carrier: string; shipping_class?: string; items: unknown[] } }>('/mocklogi/v1/shipments', async (req, reply) => {
    const d = dice(corr(req), 'mocklogi.shipment');
    const ctx = { correlation_id: d.correlationId || undefined, shipment_id: req.body.shipment_id };
    const fault = await applyFaults(settings.logistics, d);
    if (fault) { record('mocklogi', `fault.${fault.status}`, `shipment ${req.body.shipment_id}`, ctx); return reply.code(fault.status).send(fault.body); }

    const trackingNo = `${req.body.carrier === 'bulky_freight' ? 'BF' : 'HD'}${Date.now().toString().slice(-9)}${req.body.shipment_id}`;
    record('mocklogi', 'shipment.created', `#${req.body.shipment_id} ${req.body.carrier} ${trackingNo}`, ctx);
    if (settings.logistics.statusCallbacks === 'off') {
      record('mocklogi', 'callbacks.disabled', `#${req.body.shipment_id}`, ctx);   // 壓測用：不回傳狀態
      return reply.code(201).send({ tracking_no: trackingNo });
    }

    void (async () => {
      const stepMs = scaled(stepMsFor(req.body.shipping_class)); // 大型物流 demo 打開時，大型、貓砂比較慢
      const steps = ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'].map((status, i) => ({
        status, occurred_at: new Date(Date.now() + (i + 1) * stepMs).toISOString(),
      }));
      if (d.hit('out_of_order', settings.logistics.outOfOrderRate)) { steps.reverse(); record('mocklogi', 'callbacks.out_of_order', `#${req.body.shipment_id}`, ctx); }

      for (const step of steps) {
        await sleep(stepMs);
        await sendWebhook('mocklogi', {
          type: 'shipment.status', shipment_id: req.body.shipment_id, tracking_no: trackingNo,
          status: step.status, provider_event_id: `${trackingNo}-${step.status}`, status_at: step.occurred_at,
        }, d.hit(`duplicate_callback.${step.status}`, settings.logistics.duplicateRate) ? 2 : 1);
      }
    })();

    return reply.code(201).send({ tracking_no: trackingNo });
  });

  // ───────── 假寵物醫院（TCC：保留 → 確認／釋放，§6.4.1）─────────
  // Try：保留時段。hold_key 冪等（同一個 key 且還有效 → 回同一筆）
  app.post<{ Body: { hold_key: string; start_at: string; service_type: string } }>('/mockvet/v1/holds', async (req, reply) => {
    const d = dice(corr(req), 'mockvet.hold');
    const ctx = { correlation_id: d.correlationId || undefined };
    const fault = await applyFaults(settings.clinic, d);
    if (fault) { record('mockvet', `fault.${fault.status}`, 'hold', ctx); return reply.code(fault.status).send(fault.body); }

    const prev = holds.get(holdByKey.get(req.body.hold_key) ?? '');
    if (prev && (prev.status === 'held' || prev.status === 'confirmed')) return reply.code(201).send({ hold_id: prev.hold_id, expires_at: new Date(prev.expires_at).toISOString() });

    const at = Date.parse(req.body.start_at);
    if (Number.isNaN(at) || at <= Date.now()) return reply.code(422).send({ error: 'invalid_slot' });
    if (d.hit('slot_full', settings.clinic.fullRate)) {
      record('mockvet', 'hold.slot_full', req.body.start_at, ctx);
      return reply.code(409).send({ error: 'slot_full' });
    }

    const hold: Hold = {
      hold_id: `hold_${randomUUID().slice(0, 10)}`, hold_key: req.body.hold_key, start_at: req.body.start_at,
      expires_at: Date.now() + scaled(settings.clinic.holdTtlSeconds * 1000), status: 'held',   // 醫院的業務時間：跟著壓縮
    };
    holds.set(hold.hold_id, hold);
    holdByKey.set(hold.hold_key, hold.hold_id);
    record('mockvet', 'hold.created', `${hold.hold_id} ${hold.start_at}（${scaled(settings.clinic.holdTtlSeconds * 1000) / 1000}s）`, ctx);
    return reply.code(201).send({ hold_id: hold.hold_id, expires_at: new Date(hold.expires_at).toISOString() });
  });

  // Confirm：保留還有效才能確認；重複確認回同一個預約編號（冪等）
  app.post<{ Params: { id: string }; Body: { booking_id: number } }>('/mockvet/v1/holds/:id/confirm', async (req, reply) => {
    const d = dice(corr(req), 'mockvet.confirm');
    const ctx = { correlation_id: d.correlationId || undefined, hold_id: req.params.id };
    const fault = await applyFaults(settings.clinic, d);
    if (fault) { record('mockvet', `fault.${fault.status}`, 'confirm', ctx); return reply.code(fault.status).send(fault.body); }

    const h = holds.get(req.params.id);
    if (!h) return reply.code(404).send({ error: 'hold_not_found' });
    if (h.status === 'confirmed') { record('mockvet', 'confirm.idempotent_replay', h.hold_id); return { provider_booking_id: h.provider_booking_id, status: 'confirmed' }; }
    if (h.status !== 'held' || h.expires_at < Date.now()) {
      if (h.status === 'held') h.status = 'expired';
      record('mockvet', 'confirm.hold_expired', h.hold_id);
      return reply.code(410).send({ error: 'hold_expired' });
    }
    h.status = 'confirmed';
    h.provider_booking_id = `vet_${randomUUID().slice(0, 10)}`;
    record('mockvet', 'booking.confirmed', `${h.provider_booking_id} ${h.start_at}`);
    if (d.hit('confirm_response_lost', settings.clinic.confirmLostRate)) {
      // 醫院這邊已經確認了，但回應在路上丟了 → 呼叫端只看到逾時，必須重試或查詢，不能判定失敗
      record('mockvet', 'confirm.response_lost', h.hold_id, ctx);
      return reply.code(504).send({ error: 'gateway_timeout' });
    }
    return { provider_booking_id: h.provider_booking_id, status: 'confirmed' };
  });

  // Cancel：釋放時段（已確認的也會取消）；不存在也回成功（冪等）
  app.delete<{ Params: { id: string } }>('/mockvet/v1/holds/:id', async (req, reply) => {
    const fault = await applyFaults(settings.clinic, dice(corr(req), 'mockvet.release'));
    if (fault) { record('mockvet', `fault.${fault.status}`, 'release'); return reply.code(fault.status).send(fault.body); }
    const h = holds.get(req.params.id);
    if (h && h.status !== 'released') { h.status = 'released'; record('mockvet', 'hold.released', `${h.hold_id} ${h.start_at}`); }
    return reply.code(204).send();
  });

  // ───────── 假 LINE 推播 ─────────
  app.post<{ Body: { to: string; message: string } }>('/mockline/v1/push', async (req, reply) => {
    const fault = await applyFaults(settings.line, dice(corr(req), 'mockline.push'));
    if (fault) { record('mockline', `fault.${fault.status}`, req.body.to); return reply.code(fault.status).send(fault.body); }
    record('mockline', 'push', `${req.body.to}：${req.body.message}`);
    return reply.code(200).send({ ok: true });
  });
}
