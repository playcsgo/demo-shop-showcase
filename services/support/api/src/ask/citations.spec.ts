import { CitationParser } from './citations.js';

const known = new Map([
  ['sku:DCS-CAN-DUCK-80', { price: 48 }],
  ['order:A-1', { total: 878 }],
]);

function run(chunks: string[]) {
  const p = new CitationParser((key) => known.get(key));
  const out = chunks.flatMap((c) => p.feed(c));
  return [...out, ...p.flush()];
}
const text = (events: ReturnType<typeof run>) =>
  events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { text: string }).text)
    .join('');

describe('CitationParser', () => {
  it('指向本次結果的引用轉成 ref 事件，從文字移除', () => {
    const events = run(['一罐 48 元[[ref:sku:DCS-CAN-DUCK-80]]。']);
    expect(text(events)).toBe('一罐 48 元。');
    expect(events).toContainEqual({
      type: 'ref',
      key: 'sku:DCS-CAN-DUCK-80',
      data: { price: 48 },
    });
  });

  it('指向不存在資料的引用被移除並回報，不轉成 ref', () => {
    const events = run(['訂單[[ref:order:B-1]]已出貨']);
    expect(text(events)).toBe('訂單已出貨');
    expect(events).toContainEqual({ type: 'dropped', key: 'order:B-1' });
    expect(events.some((e) => e.type === 'ref')).toBe(false);
  });

  it('引用被切成好幾段也能接起來', () => {
    const events = run(['訂單', '[[re', 'f:order:', 'A-1]', ']完成']);
    expect(text(events)).toBe('訂單完成');
    expect(events).toContainEqual({
      type: 'ref',
      key: 'order:A-1',
      data: { total: 878 },
    });
  });

  it('兩個左方括號被切在兩個 chunk 也能接起來', () => {
    const events = run(['已出貨[', '[ref:order:A-1]]。']);
    expect(text(events)).toBe('已出貨。');
    expect(events).toContainEqual({
      type: 'ref',
      key: 'order:A-1',
      data: { total: 878 },
    });
  });

  it('不是引用的方括號照常輸出；沒收尾的引用在結束時當成文字', () => {
    expect(text(run(['[a] [[b']))).toBe('[a] [[b');
    expect(text(run(['價格[[ref:sku:', 'X'.repeat(300)]))).toContain('價格');
  });

  it('同一個引用出現兩次只發一次 ref', () => {
    const events = run(['a[[ref:order:A-1]] b[[ref:order:A-1]]']);
    expect(events.filter((e) => e.type === 'ref')).toHaveLength(1);
  });
});
