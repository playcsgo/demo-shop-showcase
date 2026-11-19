import { join } from 'node:path';
import { gate } from '../src/join/gate.js';
import { SopBook } from '../src/sop/sop.js';
import type { LlmMessage } from '../src/llm/llm.types.js';
import { realRunner } from './real-helpers.js';

// AIC-008：Join 判斷閘門的真實模型案例，每個跑 3 次。花額度，手動跑：scripts/support.sh llm join
if (process.env.SUPPORT_CONTAINER !== '1') throw new Error('只能在容器裡跑');

const runner = realRunner({ maxConcurrent: 5 });
const book = SopBook.load(join(process.cwd(), 'sop'));
// 和 JoinService.rules() 一樣的格式
const rules = book
  .topics()
  .flatMap((t) => {
    const s = book.get(t)!;
    return [...s.steps, ...s.exceptions].map(
      (c) => `${s.title} §${c.id} ${c.text}`,
    );
  })
  .join('\n');
const c = (text: string): LlmMessage => ({ role: 'customer', text });
const a = (text: string): LlmMessage => ({ role: 'agent', text });

const CASES: [string, 'customer' | 'agent', LlmMessage[], string][] = [
  [
    '客戶問物流',
    'customer',
    [c('我上週買的貓砂怎麼還沒到？訂單 A-1')],
    'respond',
  ],
  [
    '客戶道謝',
    'customer',
    [c('好的'), a('已經幫你查好了'), c('謝謝～')],
    'listen',
  ],
  ['客戶傳表情符號', 'customer', [a('還有其他問題嗎？'), c('👍')], 'listen'],
  [
    '客服講錯退款天數',
    'agent',
    [c('拆開的飼料可以退嗎'), a('可以喔，我們 30 天內都能退，開過的也可以')],
    'flag',
  ],
  [
    '客服推薦有警示的商品沒提醒',
    'agent',
    [c('我的貓有慢性腎病，推薦什麼罐頭'), a('推薦鮮肉主食罐，所有貓都適合')],
    'flag',
  ],
  [
    '客服回答正確',
    'agent',
    [c('你們幾點下班'), a('我們週一到週五 9:30 到 18:00 有客服在線')],
    'listen',
  ],
];

it.each(CASES)(
  '%s → %s（3 次都要對）',
  async (_name, who, messages, expected) => {
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        gate(
          runner,
          `join-${_name}`,
          who,
          messages,
          who === 'agent' ? rules : '',
        ),
      ),
    );
    console.log(
      `  ${_name} → ${results.map((r) => r?.action ?? '失敗').join(', ')}`,
    );
    for (const r of results) expect(r?.action).toBe(expected);
  },
);
