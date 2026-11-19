import { HttpException } from '@nestjs/common';
import { CoreClient } from '../core/core-client.service.js';
import type { Session } from '../auth/session.service.js';
import { OverviewController } from './overview.controller.js';

const session: Session = { sid: 's', customerId: 1, name: 'Alice', email: 'a@x', token: 't', tokenExp: 9e9 };
const sessions = { freshToken: vi.fn().mockResolvedValue('t') };

function coreWith(responses: Record<string, { status: number; data: any } | Error>) {
  return {
    call: vi.fn(async (path: string) => {
      const r = responses[path];
      if (r instanceof Error) throw r;
      return r;
    }),
  } as unknown as CoreClient;
}

describe('OverviewController', () => {
  it('4 支都成功：每一塊都有資料', async () => {
    const ctl = new OverviewController(coreWith({
      '/orders': { status: 200, data: { data: [{ order_no: 'A1' }] } },
      '/warehouse': { status: 200, data: { data: [{ name: '狗糧', balance: 10 }] } },
      '/subscriptions': { status: 200, data: { data: [] } },
      '/cart': { status: 200, data: { items: [1, 2] } },
    }), sessions as any);

    const r = await ctl.overview(session, 'corr');
    expect(r.recent_orders).toEqual({ ok: true, data: [{ order_no: 'A1' }] });
    expect(r.cart_count).toEqual({ ok: true, data: 2 });
  });

  it('寄倉 API 掛掉（503）、訂閱逾時：只有那兩塊降級，其他照常顯示', async () => {
    const ctl = new OverviewController(coreWith({
      '/orders': { status: 200, data: { data: [] } },
      '/warehouse': { status: 503, data: { error: 'down' } },
      '/subscriptions': new HttpException({ error: 'core_unavailable' }, 503),
      '/cart': { status: 200, data: { items: [] } },
    }), sessions as any);

    const r = await ctl.overview(session, 'corr');
    expect(r.recent_orders.ok).toBe(true);
    expect(r.warehouse).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect(r.subscriptions).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect(r.cart_count.ok).toBe(true);
  });
});
