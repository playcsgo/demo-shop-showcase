import { join } from 'node:path';
import { REFUND_WINDOW_DAYS } from '../../test/refund-policy.js';
import { parseSop, SopBook } from './sop.js';

const book = SopBook.load(join(process.cwd(), 'sop'));
const valid = `---
topic: demo
title: 測試
---

## 觸發條件
有人問。

## 步驟
- §S1 第一步。
- §S2 第二步。

## 例外
- §E1 例外一。
`;

describe('SOP', () => {
  it('五份 SOP 都讀得進來，條目有編號', () => {
    expect(book.topics().sort()).toEqual([
      'medical',
      'privacy',
      'recommendation',
      'refund',
      'shipping',
    ]);
    expect(book.get('refund')?.exceptions.map((e) => e.id)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
    ]);
  });

  it('每份至少三條例外', () => {
    for (const t of book.topics())
      expect(book.get(t)!.exceptions.length).toBeGreaterThanOrEqual(3);
  });

  it('條目編號重複就失敗：引用會指錯條目', () => {
    expect(() => parseSop('demo.md', valid.replace('§S2', '§S1'))).toThrow(
      '重複',
    );
  });

  it('topic 和檔名不一致就失敗', () => {
    expect(() => parseSop('other.md', valid)).toThrow('topic');
  });

  it('查得到單一條目；不存在的回 null', () => {
    expect(book.clause('refund', 'E2')?.text).toContain('已開封');
    expect(book.clause('refund', 'E9')).toBeNull();
    expect(book.get('../../.env')).toBeNull();
  });

  it('一致性：退款 SOP 寫的天數等於程式檢查用的天數', () => {
    expect(book.clause('refund', 'S2')?.text).toContain(
      `${REFUND_WINDOW_DAYS} 天`,
    );
  });
});
