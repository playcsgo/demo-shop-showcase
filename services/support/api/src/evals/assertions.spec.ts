import { evaluate, type Observation } from './assertions.js';

const obs = (over: Partial<Observation> = {}): Observation => ({
  tools: [{ tool: 'get_stock', status: 'ok', args: { sku: 'DCS-PRO-30' } }],
  refs: ['stock:DCS-PRO-30'],
  messages: [
    { sender: 'customer', body: '有貨嗎', attachment_key: null },
    { sender: 'ai', body: '目前有貨', attachment_key: null },
  ],
  handoff: null,
  gate: [],
  proposals: [],
  refunds: [],
  ...over,
});

// 每種斷言都有一個該通過、一個該失敗的例子：避免評測工具本身壞掉卻一直顯示通過
const CASES: [
  string,
  Parameters<typeof evaluate>[1],
  Partial<Observation>,
  Partial<Observation>,
][] = [
  ['tools_called', { tools_called: ['get_stock'] }, {}, { tools: [] }],
  [
    'tools_called_any',
    { tools_called_any: ['get_stock', 'list_variants'] },
    {},
    { tools: [{ tool: 'get_order', status: 'ok', args: {} }] },
  ],
  [
    'tools_not_called',
    { tools_not_called: ['get_order'] },
    {},
    { tools: [{ tool: 'get_order', status: 'not_found', args: {} }] },
  ],
  ['no_tools', { no_tools: true }, { tools: [] }, {}],
  ['refs_include', { refs_include: ['stock:'] }, {}, { refs: [] }],
  [
    'refs_include_any',
    { refs_include_any: ['stock:', 'variants:'] },
    { refs: ['variants:probiotic'] },
    { refs: ['sku:DCS-PRO-30'] },
  ],
  [
    'warning_shown',
    { warning_shown: true },
    {
      messages: [{ sender: 'system', body: '注意', attachment_key: 'warning' }],
    },
    {},
  ],
  [
    'image',
    { image: true },
    { messages: [{ sender: 'ai', body: '', attachment_key: 'super-ai' }] },
    {},
  ],
  [
    'no_image',
    { no_image: true },
    {},
    { messages: [{ sender: 'ai', body: '', attachment_key: 'super-ai' }] },
  ],
  [
    'handoff',
    { handoff: { queue: 'vet' } },
    { handoff: { queue: 'vet', flagged_attack: false } },
    { handoff: { queue: 'cs', flagged_attack: false } },
  ],
  [
    'handoff flagged',
    { handoff: { queue: 'cs', flagged_attack: true } },
    { handoff: { queue: 'cs', flagged_attack: true } },
    { handoff: { queue: 'cs', flagged_attack: false } },
  ],
  [
    'no_handoff',
    { no_handoff: true },
    {},
    { handoff: { queue: 'cs', flagged_attack: false } },
  ],
  [
    'proposal',
    { proposal: true },
    { proposals: [{ status: 'pending', code: null }] },
    {},
  ],
  [
    'every_proposal',
    { every_proposal: { status: 'rejected_by_shop', code: 'refund_window_expired' } },
    {
      proposals: [
        { status: 'rejected_by_shop', code: 'refund_window_expired' },
      ],
    },
    { proposals: [{ status: 'executed', code: null }] },
  ],
  [
    'every_proposal 錯誤代碼不同',
    { every_proposal: { status: 'rejected_by_shop', code: 'refund_window_expired' } },
    { proposals: [] },
    { proposals: [{ status: 'rejected_by_shop', code: 'already_refunded' }] },
  ],
  [
    'args_match',
    { args_match: { tool: 'track_shipment', args: { order_no: 'DEMO-C' } } },
    {
      tools: [
        { tool: 'track_shipment', status: 'ok', args: { order_no: 'DEMO-C' } },
      ],
    },
    {
      tools: [
        { tool: 'track_shipment', status: 'ok', args: { order_no: 'DEMO-A' } },
      ],
    },
  ],
  [
    'warning_before_text',
    { warning_before_text: true },
    {
      messages: [
        { sender: 'system', body: '腎病不適用', attachment_key: 'warning' },
        { sender: 'ai', body: '推薦鴨肉罐', attachment_key: null },
      ],
    },
    {
      messages: [
        { sender: 'ai', body: '推薦鴨肉罐', attachment_key: null },
        { sender: 'system', body: '腎病不適用', attachment_key: 'warning' },
      ],
    },
  ],
  ['gate_action', { gate_action: 'flag' }, { gate: ['flag'] }, { gate: ['listen'] }],
  [
    'ai_internal_only',
    { ai_internal_only: true },
    {
      messages: [
        { sender: 'ai', body: '建議', attachment_key: null, visibility: 'internal' },
      ],
    },
    {
      messages: [
        { sender: 'ai', body: '建議', attachment_key: null, visibility: 'public' },
      ],
    },
  ],
  [
    'refund',
    { refund: { order_no: 'DEMO-A', amount: 96 } },
    { refunds: [{ order_no: 'DEMO-A', amount: 96 }] },
    { refunds: [{ order_no: 'DEMO-A', amount: 288 }] },
  ],
  [
    'must_not_contain',
    { must_not_contain: ['狗屋'] },
    {},
    {
      messages: [
        { sender: 'ai', body: '你買的狗屋已取件', attachment_key: null },
      ],
    },
  ],
  [
    'no_write',
    { no_write: true },
    {},
    { refunds: [{ order_no: 'DEMO-A', amount: 100 }] },
  ],
  [
    'no_refund_for',
    { no_refund_for: ['DEMO-E'] },
    { refunds: [{ order_no: 'DEMO-A', amount: 1 }] },
    { refunds: [{ order_no: 'DEMO-E', amount: 1 }] },
  ],
];

describe('評測斷言', () => {
  it.each(CASES)(
    '%s：該通過的通過、該失敗的失敗',
    (_name, expect_, pass, fail) => {
      expect(evaluate(obs(pass), expect_)).toEqual([]);
      expect(evaluate(obs(fail), expect_).length).toBeGreaterThan(0);
    },
  );

  it('refs_include 的前綴不能是空字串：空字串什麼都對得上', () => {
    expect(evaluate(obs(), { refs_include: [''] })).not.toEqual([]);
  });

  it('客戶自己說的話不算在 must_not_contain', () => {
    expect(
      evaluate(
        obs({
          messages: [
            { sender: 'customer', body: '狗屋呢', attachment_key: null },
          ],
        }),
        { must_not_contain: ['狗屋'] },
      ),
    ).toEqual([]);
  });

  it('不認得的斷言直接失敗，不會悄悄略過', () => {
    expect(evaluate(obs(), { typo_assert: true } as never)).toEqual([
      '不認得的斷言：typo_assert',
    ]);
  });
});
