import { createHmac, randomUUID } from 'node:crypto';
import { record } from './events.js';
import { scaled } from './dice.js';
import { sleep } from './faults.js';

// 送 webhook 給 hub；HMAC 簽章（t=時間戳記, v1=HMAC(secret, t.body)）防偽造與重放
const HUB = process.env.HUB_WEBHOOK_BASE ?? 'http://hub:3000/webhooks';
const SECRETS: Record<string, string> = {
  mockpay: process.env.MOCKPAY_WEBHOOK_SECRET ?? 'mockpay-secret',
  mocklogi: process.env.MOCKLOGI_WEBHOOK_SECRET ?? 'mocklogi-secret',
};

export function sign(provider: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', SECRETS[provider]).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** 真實廠商的 webhook 也會重試：失敗時 1s、3s、9s 再送 */
export async function sendWebhook(provider: string, payload: { type: string } & Record<string, unknown>, copies = 1): Promise<void> {
  const event = { event_id: randomUUID(), occurred_at: new Date().toISOString(), ...payload }; // 重複送的副本 event_id 相同
  const body = JSON.stringify(event);

  for (let copy = 0; copy < copies; copy++) {
    for (const wait of [0, 1000, 3000, 9000]) {
      await sleep(scaled(wait));   // 廠商自己的重送間隔：外部世界的時間，跟著壓縮
      try {
        const res = await fetch(`${HUB}/${provider}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mock-signature': sign(provider, body) },
          body,
          signal: AbortSignal.timeout(5000),
        });
        record(provider, copy === 0 ? 'webhook.sent' : 'webhook.duplicate', `${event.type} → ${res.status}`);
        if (res.ok) break;
      } catch (e) {
        record(provider, 'webhook.error', `${event.type}: ${(e as Error).message}`);
      }
    }
  }
}
