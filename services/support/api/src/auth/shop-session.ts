import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';

// 客戶是誰，由商店決定（AIC-015）：瀏覽器打 support 時帶著商店的 sid cookie（同網域），
// support 拿它問 BFF。support 自己不存客戶密碼，也不發客戶帳號

export const SHOP_SESSIONS = Symbol('SHOP_SESSIONS');
export const SHOP_SID_COOKIE = 'sid'; // BFF 的 session cookie

export interface ShopIdentity {
  customerId: number;
  name: string;
}

export interface ShopSessions {
  /** 無效、登出、BFF 掛了：都回 null，當成匿名（AC-32） */
  resolve(sid: string | undefined): Promise<ShopIdentity | null>;
}

export const CACHE_MS = 30_000;
const TIMEOUT_MS = 2000;

/** 呼叫 BFF 的 /internal/session/resolve。結果快取 30 秒：登出最晚 30 秒生效，又不用每則訊息都打 BFF */
export class BffShopSessions implements ShopSessions {
  private readonly logger = new Logger('shop-session');
  // key 是 sid 的雜湊：記憶體裡也不留原文
  private readonly cache = new Map<string, { at: number; value: ShopIdentity | null }>();

  constructor(
    private readonly bffUrl: string,
    private readonly key: string,
  ) {
    if (!bffUrl || !key) throw new Error('缺少 BFF_URL 或 SUPPORT_SERVICE_KEY');
  }

  async resolve(sid: string | undefined): Promise<ShopIdentity | null> {
    if (!sid || sid.length > 100) return null;
    const k = createHash('sha256').update(sid).digest('hex');
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

    let value: ShopIdentity | null = null;
    try {
      const res = await fetch(`${this.bffUrl}/internal/session/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-key': this.key },
        body: JSON.stringify({ sid }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { valid: boolean; customer_id?: number; name?: string };
        if (body.valid && Number.isInteger(body.customer_id)) value = { customerId: body.customer_id!, name: body.name ?? '' };
      } else {
        // BFF 出錯不快取：恢復後馬上認得人
        this.logger.warn(`BFF 回 ${res.status}，當成匿名`);
        return null;
      }
    } catch {
      this.logger.warn('BFF 連不上，當成匿名');
      return null;
    }
    if (this.cache.size > 10_000) this.cache.clear(); // 只是快取：滿了就整個清掉，不會記憶體一直長
    this.cache.set(k, { at: Date.now(), value });
    return value;
  }
}
