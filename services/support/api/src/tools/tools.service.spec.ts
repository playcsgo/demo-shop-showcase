import type { Pool, RowDataPacket } from 'mysql2/promise';
import { aiRun } from '../../test/ai-fixtures.js';
import { testDb, testEnv, truncate } from '../../test/db.js';
import { fakeShop, shopFixture } from '../../test/fixtures.js';
import { ToolCallLog } from '../audit/tool-call-log.js';
import { seed } from '../db/seed.js';
import type { ShopClient } from '../shop/shop-client.js';
import { SopBook } from '../sop/sop.js';
import { join } from 'node:path';
import type { RunContext } from './run-token.service.js';
import { ToolsService } from './tools.service.js';

let db: Pool;
let tools: ToolsService;
let alice: number;
let bob: number;
beforeAll(() => {
  db = testDb();
  tools = new ToolsService(
    new ToolCallLog(db),
    fakeShop,
    SopBook.load(join(process.cwd(), 'sop')),
  );
});
afterAll(() => db.end());
beforeEach(async () => {
  await truncate(db);
  await seed(db, testEnv);
  ({ alice, bob } = await shopFixture(db));
});

async function ctx(
  role: RunContext['role'],
  customerId: number | null,
  agentId: number | null = null,
): Promise<RunContext> {
  const { runId, conversationId } = await aiRun(db, {
    actor: role === 'agent' ? 'agent' : 'customer',
    agentId,
  });
  return { runId, conversationId, role, customerId, agentId };
}
const parse = (r: { content: string }) => JSON.parse(r.content);

describe('工具清單依角色', () => {
  it('匿名沒有訂單工具；客戶沒有 find_customer；客服沒有 transfer 和 request_login', () => {
    const names = (role: RunContext['role']) =>
      tools.listFor(role).map((t) => t.name);
    expect(names('anonymous')).not.toEqual(
      expect.arrayContaining(['list_orders']),
    );
    expect(names('anonymous')).toContain('request_login');
    expect(names('customer')).toEqual(
      expect.arrayContaining(['list_orders', 'get_order', 'get_refund_status']),
    );
    expect(names('customer')).not.toContain('find_customer');
    expect(names('agent')).toContain('find_customer');
    expect(names('agent')).not.toEqual(expect.arrayContaining(['transfer']));
    // AC-5：客戶端不能提案；只有客服身分有（AIC-009）
    for (const role of ['anonymous', 'customer'] as const)
      expect(names(role)).not.toContain('propose_action');
    expect(names('agent')).toContain('propose_action');
  });

  it('Join：和客服一樣，只少了 find_customer', () => {
    const names = (role: RunContext['role']) =>
      tools.listFor(role).map((t) => t.name);
    expect(names('join')).toEqual(
      names('agent').filter((n) => n !== 'find_customer'),
    );
  });
});

describe('AC-29：工具權限', () => {
  it('匿名呼叫訂單工具被拒，不會查到資料', async () => {
    const r = await tools.call(await ctx('anonymous', null), 'list_orders', {});
    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual({ error: 'denied' });
  });

  it('參數裡夾帶 customer_id 被忽略，只用 token 裡的客戶', async () => {
    const r = await tools.call(await ctx('customer', alice), 'list_orders', {
      customer_id: bob,
    });
    expect(
      parse(r).orders.map((o: { order_no: string }) => o.order_no),
    ).toEqual(['A-1']);
  });

  it('alice 查 bob 的訂單回 not_found，和不存在的訂單一樣', async () => {
    const c = await ctx('customer', alice);
    expect(
      parse(await tools.call(c, 'get_order', { order_no: 'B-1' })),
    ).toEqual({ error: 'not_found' });
    expect(
      parse(await tools.call(c, 'get_order', { order_no: 'ZZ-9' })),
    ).toEqual({ error: 'not_found' });
  });

  it('客戶呼叫 find_customer 被拒', async () => {
    expect(
      parse(
        await tools.call(await ctx('customer', alice), 'find_customer', {
          query: 'bob',
        }),
      ),
    ).toEqual({ error: 'denied' });
  });

  it('客服只能查目前對話的客戶；對話沒有客戶時查不到', async () => {
    expect(
      parse(
        await tools.call(await ctx('agent', alice, 1), 'get_order', {
          order_no: 'A-1',
        }),
      ).order.order_no,
    ).toBe('A-1');
    expect(
      parse(
        await tools.call(await ctx('agent', alice, 1), 'get_order', {
          order_no: 'B-1',
        }),
      ),
    ).toEqual({ error: 'not_found' });
    expect(
      parse(await tools.call(await ctx('agent', null, 1), 'list_orders', {})),
    ).toEqual({ error: 'not_found' });
  });

  it.each([
    ['get_product_doc', { slug: '../../.env' }],
    ['get_product_spec', { sku: "' OR 1=1 --" }],
    ['get_order', { order_no: 123 }],
    ['find_customer', { query: 'x'.repeat(100) }],
    ['transfer', { queue: 'admin', reason: 'x' }],
  ])('%s 的參數不合法被拒', async (name, args) => {
    const r = await tools.call(await ctx('agent', alice, 1), name, args);
    expect(parse(r)).toMatchObject({
      error: expect.stringMatching(/invalid|denied/),
    });
  });

  it('不存在的工具被拒', async () => {
    expect(
      parse(
        await tools.call(await ctx('customer', alice), 'run_sql', { q: 'x' }),
      ),
    ).toEqual({ error: 'denied' });
  });
});

describe('結果和紀錄', () => {
  it('商品工具回資料並登記引用；引用的資料是當時的結果', async () => {
    const c = await ctx('anonymous', null);
    const r = await tools.call(c, 'get_product_spec', {
      sku: 'DCS-CAN-DUCK-80',
    });
    expect(parse(r).spec.price).toBe(48);
    expect(parse(r).ref).toBe('sku:DCS-CAN-DUCK-80');
    expect(tools.refLookup(c.runId)('sku:DCS-CAN-DUCK-80')).toMatchObject({
      price: 48,
    });
    expect(tools.refLookup(c.runId)('sku:DCS-PRO-30')).toBeUndefined();
  });

  it('引用表在工具呼叫之前取得也查得到（解析器比工具先建立）', async () => {
    const c = await ctx('anonymous', null);
    const lookup = tools.refLookup(c.runId);
    await tools.call(c, 'get_stock', { sku: 'DCS-PRO-30' });
    expect(lookup('stock:DCS-PRO-30')).toMatchObject({ in_stock: true });
  });

  it('別次執行登記的引用查不到', async () => {
    const a = await ctx('anonymous', null);
    const b = await ctx('anonymous', null);
    await tools.call(a, 'get_stock', { sku: 'DCS-PRO-30' });
    expect(tools.refLookup(b.runId)('stock:DCS-PRO-30')).toBeUndefined();
  });

  it('資料沒寫的欄位原樣回 null', async () => {
    const r = await tools.call(
      await ctx('anonymous', null),
      'get_product_spec',
      { sku: 'DCS-MAT-1' },
    );
    expect(parse(r).spec.shelf_life_days).toBeNull();
  });

  it('每次呼叫都記錄；AC-6：客服的查詢記下是誰', async () => {
    const c = await ctx('agent', alice, 1);
    await tools.call(c, 'get_order', { order_no: 'A-1' });
    await tools.call(c, 'get_order', { order_no: 'B-1' });
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT tool, agent_id, status FROM tool_calls WHERE run_id = ? ORDER BY created_at',
      [c.runId],
    );
    expect(rows).toEqual([
      { tool: 'get_order', agent_id: 1, status: 'ok' },
      { tool: 'get_order', agent_id: 1, status: 'not_found' },
    ]);
  });

  it('shop 拋錯時回 error，不洩漏錯誤細節', async () => {
    const broken = new ToolsService(
      new ToolCallLog(db),
      {
        variant: () => Promise.reject(new Error('DB 密碼錯誤')),
      } as unknown as ShopClient,
      SopBook.load(join(process.cwd(), 'sop')),
    );
    const r = await broken.call(await ctx('anonymous', null), 'get_stock', {
      sku: 'DCS-PRO-30',
    });
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain('密碼');
  });

  it('AC-43：商店掛了或逾時，工具回 shop_unavailable；帶的身分是本人或客服', async () => {
    fakeShop.down = true;
    const r = await tools.call(await ctx('customer', alice), 'get_order', { order_no: 'A-1' });
    expect(r).toEqual({ content: JSON.stringify({ error: 'shop_unavailable' }), isError: true });
    fakeShop.down = false;
    fakeShop.calls.length = 0;
    await tools.call(await ctx('customer', alice), 'list_orders', {});
    await tools.call(await ctx('agent', alice, 1), 'get_order', { order_no: 'A-1' });
    await tools.call(await ctx('anonymous', null), 'get_stock', { sku: 'DCS-PRO-30' });
    expect(fakeShop.calls).toEqual([
      ['orders', `customer:${alice}`],
      ['order', 'staff:1'],
      ['variant', undefined],
    ]);
  });

  it('transfer 和 request_login 記成訊號，給 Ask 在執行結束後處理', async () => {
    const c = await ctx('anonymous', null);
    await tools.call(c, 'request_login', {});
    await tools.call(c, 'transfer', { queue: 'cs', reason: '要退款' });
    expect(tools.signals(c.runId)).toEqual([
      { type: 'login' },
      { type: 'transfer', queue: 'cs', reason: '要退款' },
    ]);
  });
});

describe('物流工具（AIC-005）', () => {
  it('estimate_delivery 依 SKU 的運送類別和目前設定算；缺貨時一起回', async () => {
    const r = parse(
      await tools.call(await ctx('anonymous', null), 'estimate_delivery', {
        sku: 'DCS-DH-L',
      }),
    );
    expect(r.estimate).toMatchObject({
      shipping_class: 'bulky',
      estimated_seconds: 4.5,
      in_stock: false,
    });
  });

  it('track_shipment 只查得到自己的訂單；匿名不能用', async () => {
    expect(
      parse(
        await tools.call(await ctx('customer', alice), 'track_shipment', {
          order_no: 'A-1',
        }),
      ).shipments,
    ).toHaveLength(1);
    expect(
      parse(
        await tools.call(await ctx('customer', alice), 'track_shipment', {
          order_no: 'B-1',
        }),
      ),
    ).toEqual({ error: 'not_found' });
    expect(
      parse(
        await tools.call(await ctx('anonymous', null), 'track_shipment', {
          order_no: 'A-1',
        }),
      ),
    ).toEqual({ error: 'denied' });
  });

  it('AC-56：物流商故障時預估回 shop_unavailable（不給假的時間），紀錄是 shop_down', async () => {
    fakeShop.logisticsDown = true;
    const c = await ctx('customer', alice);
    const r = await tools.call(c, 'estimate_delivery', { sku: 'DCS-LIT-1' });
    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual({ error: 'shop_unavailable' });
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT status FROM tool_calls WHERE run_id = ?',
      [c.runId],
    );
    expect(rows).toEqual([{ status: 'shop_down' }]);
  });
});

describe('SOP 工具（AIC-007）', () => {
  it('get_sop 回整份 SOP，每個條目都可以引用', async () => {
    const c = await ctx('anonymous', null);
    const r = parse(await tools.call(c, 'get_sop', { topic: 'refund' }));
    expect(r.sop.title).toBe('退款');
    expect(tools.refLookup(c.runId)('sop:refund#E2')).toMatchObject({
      id: 'E2',
    });
    expect(parse(await tools.call(c, 'get_sop', { topic: 'nope' }))).toEqual({
      error: 'not_found',
    });
  });

  it('讀商品全文時記下警示，給 Ask 先顯示', async () => {
    const c = await ctx('anonymous', null);
    await tools.call(c, 'get_product_doc', { slug: 'probiotics' });
    await tools.call(c, 'get_product_doc', { slug: 'probiotics' });
    await tools.call(c, 'get_product_doc', { slug: 'cat-grass-kit' });
    expect(tools.drainWarnings(c.runId)).toEqual([
      {
        slug: 'probiotics',
        name: '寵物益生菌',
        warnings: expect.arrayContaining([expect.stringContaining('抗生素')]),
      },
      { slug: 'cat-grass-kit', name: '貓草栽培盒', warnings: [] },
    ]);
    expect(tools.drainWarnings(c.runId)).toEqual([]);
  });
});
