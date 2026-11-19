import {
  ask,
  collect,
  lastOf,
  realRunner,
  startEchoServer,
} from './real-helpers.js';

// 速度實測：fast、main 各跑 N 次（一次一個，不併發）。目標：判斷閘門 3 秒內、第一個字 5 秒內
const N = Number(process.env.LATENCY_RUNS ?? 10);
const SCHEMA = {
  type: 'object',
  properties: {
    decision: { enum: ['respond', 'listen'] },
    reason: { type: 'string' },
  },
  required: ['decision', 'reason'],
};

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
};
const line = (name: string, values: number[]) =>
  `${name.padEnd(18)} p50=${pct(values, 50)}ms p95=${pct(values, 95)}ms min=${Math.min(...values)}ms max=${Math.max(...values)}ms n=${values.length}`;

async function measure(
  tier: 'fast' | 'main',
  prompt: string,
  jsonSchema?: object,
  mcp?: { url: string; token: string; allowedTools: string[] },
) {
  const runner = realRunner();
  const usage = [];
  for (let i = 0; i < N; i++) {
    const last = lastOf(
      await collect(runner.run(ask(prompt, { tier, jsonSchema, mcp }))),
    );
    if (last.type !== 'done')
      throw new Error(
        `第 ${i + 1} 次失敗：${last.type === 'error' ? last.code : ''}`,
      );
    usage.push(last.usage);
  }
  return usage;
}

it(`速度實測（各 ${N} 次）`, { timeout: 900_000 }, async () => {
  const fast = await measure(
    'fast',
    '客戶說：狗糧還有貨嗎？判斷要回應還是繼續傾聽。',
    SCHEMA,
  );
  const main = await measure('main', '用兩句話介紹貓。');
  // 真正的 Ask 一定帶 MCP：這組才是客戶感受到的速度
  const server = await startEchoServer();
  const withMcp = await measure(
    'main',
    '用兩句話介紹貓，不用呼叫工具。',
    undefined,
    { url: server.url, token: 't', allowedTools: ['echo'] },
  );
  server.close();
  console.log(
    [
      '',
      line(
        'main+MCP 到 init',
        withMcp.map((u) => u.initMs!),
      ),
      line(
        'main+MCP 第一個字',
        withMcp.map((u) => u.ttftMs!),
      ),
      line(
        'main+MCP 總時間',
        withMcp.map((u) => u.totalMs),
      ),
      line(
        'fast 啟動到 init',
        fast.map((u) => u.initMs!),
      ),
      line(
        'fast 總時間',
        fast.map((u) => u.totalMs),
      ),
      line(
        'main 啟動到 init',
        main.map((u) => u.initMs!),
      ),
      line(
        'main 第一個字',
        main.map((u) => u.ttftMs!),
      ),
      line(
        'main 總時間',
        main.map((u) => u.totalMs),
      ),
    ].join('\n'),
  );
});
