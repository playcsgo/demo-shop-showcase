import { Controller, Get, UseGuards } from '@nestjs/common';
import { CoreClient } from '../core/core-client.service.js';
import { CorrelationId, CurrentSession, SessionGuard } from '../auth/session.guard.js';
import type { Session } from '../auth/session.service.js'; // interface 用在裝飾器參數上 → 要用 import type
import { SessionService } from '../auth/session.service.js';

/**
 * 會員中心總覽（§6.5）：一支 API 取代前台的「HTML → JS → token → 好幾支 API」瀑布。
 *  - 在伺服器端「平行」呼叫 core（同機房，延遲很低）
 *  - 每支有逾時預算（800 ms）；某一支失敗或太慢 → 只有那一塊顯示降級內容，整頁不會壞
 * 對照電商實測：會員頁要先等 WordPress 外殼、再換 token、再打 3 個網域的 API。
 */
@Controller('api/me')
export class OverviewController {
  constructor(private readonly core: CoreClient, private readonly sessions: SessionService) {}

  @Get('overview')
  @UseGuards(SessionGuard)
  async overview(@CurrentSession() s: Session, @CorrelationId() corr: string) {
    const token = await this.sessions.freshToken(s, corr);
    const get = (path: string) => this.core.call<any>(path, { token, correlationId: corr, timeoutMs: 800 }).then(CoreClient.unwrap);

    const started = Date.now();
    const [orders, warehouse, subscriptions, cart] = await Promise.allSettled([
      get('/orders'), get('/warehouse'), get('/subscriptions'), get('/cart'),
    ]);
    const section = <T>(r: PromiseSettledResult<T>, pick: (v: T) => unknown) =>
      r.status === 'fulfilled' ? { ok: true, data: pick(r.value) } : { ok: false, error: 'temporarily_unavailable' };

    return {
      customer: { name: s.name },
      recent_orders: section(orders, (v: any) => v.data.slice(0, 5)),
      warehouse: section(warehouse, (v: any) => v.data),
      subscriptions: section(subscriptions, (v: any) => v.data),
      cart_count: section(cart, (v: any) => v.items.length),
      took_ms: Date.now() - started,
    };
  }
}
