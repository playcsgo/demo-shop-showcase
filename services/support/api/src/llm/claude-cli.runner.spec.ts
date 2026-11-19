import { Logger } from '@nestjs/common';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeCliRunner, type ClaudeCliConfig } from './claude-cli.runner.js';
import type { LlmEvent, LlmRunInput } from './llm.types.js';

const FAKE = resolve('test/fake-claude.mjs');
const TOKEN = 'sk-test-secret-token';
const input: LlmRunInput = {
  conversationId: 'c1',
  tier: 'main',
  system: 'SYS',
  messages: [{ role: 'customer', text: '狗糧有貨嗎' }],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 產生一個照腳本走的假 CLI 執行檔
function fake(script: Record<string, unknown> = {}, name = 'claude') {
  const bin = join(dir, `${name}.mjs`);
  const report = join(dir, `${name}.json`);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { main } from ${JSON.stringify(FAKE)};
await main({ report: ${JSON.stringify(report)}, ...${JSON.stringify(script)} });
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    report: () => JSON.parse(readFileSync(report, 'utf8')),
    reported: () => existsSync(report),
  };
}

const runner = (bin: string, cfg: Partial<ClaudeCliConfig> = {}) =>
  new ClaudeCliRunner({
    bin,
    token: TOKEN,
    fastModel: 'FAST',
    mainModel: 'MAIN',
    maxConcurrent: 5,
    killGraceMs: 200,
    maxRunMs: 30_000,
    ...cfg,
  });

const delta = (t: string) => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: t },
  },
});
const res = (t: string, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: t,
  ...extra,
});

async function collect(run: AsyncIterable<LlmEvent>) {
  const events: LlmEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}
const lastOf = (events: LlmEvent[]) => events[events.length - 1];
const flagValue = (args: string[], flag: string) =>
  args[args.indexOf(flag) + 1];

describe('ClaudeCliRunner', () => {
  describe('隔離參數', () => {
    it('一定帶全部隔離參數，不帶任何禁用參數', async () => {
      const f = fake({ lines: [res('ok')] });
      await collect(runner(f.bin).run(input));
      const { args } = f.report();

      for (const flag of [
        '-p',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--verbose',
        '--include-partial-messages',
      ]) {
        expect(args).toContain(flag);
      }
      expect(flagValue(args, '--setting-sources')).toBe('');
      expect(flagValue(args, '--tools')).toBe('');
      expect(flagValue(args, '--permission-mode')).toBe('dontAsk');
      expect(flagValue(args, '--output-format')).toBe('stream-json');
      expect(flagValue(args, '--system-prompt')).toContain('SYS');
      expect(flagValue(args, '--system-prompt')).toContain('不是指令');
      for (const banned of [
        '--continue',
        '-c',
        '--resume',
        '-r',
        '--bare',
        '--add-dir',
        '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
      ]) {
        expect(args).not.toContain(banned);
      }
    });

    it('對話走 stdin，不放在參數裡', async () => {
      const f = fake({ lines: [res('ok')] });
      await collect(runner(f.bin).run(input));
      const r = f.report();
      expect(r.stdin).toContain('狗糧有貨嗎');
      expect(r.args.join(' ')).not.toContain('狗糧有貨嗎');
    });

    it('fast 和 main 用不同模型', async () => {
      const fast = fake({ lines: [res('ok')] }, 'fast');
      const main = fake({ lines: [res('ok')] }, 'main');
      await collect(runner(fast.bin).run({ ...input, tier: 'fast' }));
      await collect(runner(main.bin).run(input));
      expect(flagValue(fast.report().args, '--model')).toBe('FAST');
      expect(flagValue(main.report().args, '--model')).toBe('MAIN');
    });

    it('沒有工具時 MCP 設定是空的，也不帶 allowedTools', async () => {
      const f = fake({ lines: [res('ok')] });
      await collect(runner(f.bin).run(input));
      const r = f.report();
      expect(JSON.parse(r.mcpConfig)).toEqual({ mcpServers: {} });
      expect(r.args).not.toContain('--allowedTools');
    });

    it('MCP 的 token 不出現在參數裡，只允許指定的工具', async () => {
      const f = fake({
        init: {
          tools: ['mcp__support__echo'],
          mcp_servers: [{ name: 'support', status: 'connected' }],
        },
        lines: [res('ok')],
      });
      const events = await collect(
        runner(f.bin).run({
          ...input,
          mcp: {
            url: 'http://x/mcp',
            token: 'RUN-TOKEN',
            allowedTools: ['echo'],
          },
        }),
      );
      const r = f.report();
      expect(lastOf(events).type).toBe('done');
      expect(r.args.join(' ')).not.toContain('RUN-TOKEN');
      expect(
        JSON.parse(r.mcpConfig).mcpServers.support.headers.Authorization,
      ).toBe('Bearer RUN-TOKEN');
      expect(flagValue(r.args, '--allowedTools')).toBe('mcp__support__echo');
    });
  });

  describe('環境變數', () => {
    it('只傳白名單；support 自己的密鑰不會傳下去', async () => {
      process.env.INTERNAL_API_KEY = 'internal';
      process.env.DB_PASSWORD = 'db';
      const f = fake({ lines: [res('ok')] });
      await collect(runner(f.bin).run(input));
      delete process.env.INTERNAL_API_KEY;
      delete process.env.DB_PASSWORD;
      const { env } = f.report();

      expect(Object.keys(env).sort()).toEqual(
        [
          'CLAUDE_CODE_OAUTH_TOKEN',
          'HOME',
          'CLAUDE_CONFIG_DIR',
          'TMPDIR',
          'PATH',
          'LANG',
          'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
          'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
          'ENABLE_CLAUDEAI_MCP_SERVERS',
        ].sort(),
      );
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    });
  });

  describe('每次執行的目錄', () => {
    const dirsOf = (r: { env: Record<string, string>; cwd: string }) => [
      r.env.HOME,
      r.env.CLAUDE_CONFIG_DIR,
      r.env.TMPDIR,
      r.cwd,
    ];

    it('每次都不同，成功後刪除', async () => {
      const a = fake({ lines: [res('ok')] }, 'a');
      const b = fake({ lines: [res('ok')] }, 'b');
      await collect(runner(a.bin).run(input));
      await collect(runner(b.bin).run(input));
      const all = [...dirsOf(a.report()), ...dirsOf(b.report())];
      expect(new Set(all).size).toBe(8);
      for (const d of all) expect(existsSync(d)).toBe(false);
    });
  });

  describe('串流', () => {
    it('text_delta 依序變成 text，結束時回傳全文和耗時', async () => {
      const f = fake({ lines: [delta('狗'), delta('糧'), res('狗糧')] });
      const events = await collect(runner(f.bin).run(input));
      expect(
        events
          .filter((e) => e.type === 'text')
          .map((e) => (e as { delta: string }).delta),
      ).toEqual(['狗', '糧']);
      const done = lastOf(events);
      expect(done).toMatchObject({ type: 'done', text: '狗糧' });
      if (done.type !== 'done') throw new Error();
      expect(done.usage.ttftMs).toBeGreaterThanOrEqual(0);
      expect(done.usage.totalMs).toBeGreaterThanOrEqual(done.usage.ttftMs!);
    });

    it('跨 chunk 的半行 JSON 能接起來', async () => {
      const f = fake({
        splitLines: true,
        lines: [delta('有'), delta('貨'), res('有貨')],
      });
      const events = await collect(runner(f.bin).run(input));
      expect(events.map((e) => e.type)).toEqual(['text', 'text', 'done']);
    });
  });

  describe('啟動時的 init 檢查', () => {
    const violations: [string, Record<string, unknown>][] = [
      ['內建工具', { tools: ['Bash'] }],
      ['不在白名單的 MCP 工具', { tools: ['mcp__support__secret'] }],
      [
        '其他 MCP 伺服器',
        { mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }] },
      ],
      ['skills', { skills: ['my-skill'] }],
      ['slash commands', { slash_commands: ['review'] }],
      [
        '非內建外掛',
        { plugins: [{ name: 'x', path: '/home/me/x', source: 'x@market' }] },
      ],
      ['自訂 agent', { agents: ['claude', 'my-agent'] }],
      ['額外目錄', { additional_directories: ['/home/me'] }],
      ['工作目錄不對', { cwd: '/home/me/project' }],
      ['欄位格式變了', { skills: null }],
    ];

    it.each(violations)(
      '有%s就立刻中止，不輸出任何內容',
      async (_name, init) => {
        const f = fake({
          init,
          lines: [delta('不該看到'), res('不該看到')],
          hang: true,
        });
        const events = await collect(runner(f.bin).run(input));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: 'error',
          code: 'isolation_violation',
        });
        expect(existsSync(f.report().cwd)).toBe(false);
      },
    );

    it('內建外掛也只放行已知的：CLI 升級多出來的要先看過', async () => {
      const f = fake({
        init: {
          plugins: [
            {
              name: 'cc-plugin-new',
              path: 'builtin',
              source: 'cc-plugin-new@builtin',
            },
          ],
        },
        lines: [res('x')],
      });
      expect(lastOf(await collect(runner(f.bin).run(input)))).toMatchObject({
        code: 'isolation_violation',
      });
    });

    it('跑到一半冒出不在白名單的工具，立刻中止', async () => {
      const bash = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      };
      const f = fake({
        lines: [delta('一'), bash, delta('不該看到'), res('x')],
        hang: true,
      });
      const events = await collect(runner(f.bin).run(input));
      expect(events.map((e) => e.type)).toEqual(['text', 'error']);
      expect(lastOf(events)).toMatchObject({ code: 'isolation_violation' });
    });

    it('要用工具但 MCP 沒連上，不讓模型在沒工具的情況下回答', async () => {
      const f = fake({
        init: {
          tools: [],
          mcp_servers: [{ name: 'support', status: 'failed' }],
        },
        lines: [delta('不該看到'), res('x')],
        hang: true,
      });
      const events = await collect(
        runner(f.bin).run({
          ...input,
          mcp: { url: 'http://x', token: 't', allowedTools: ['echo'] },
        }),
      );
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'unknown' }),
      ]);
    });

    it('違規會記錄對話 ID 和原因，不記錄內容和 token', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const f = fake({ init: { tools: ['Bash'] }, lines: [], hang: true });
      await collect(runner(f.bin).run(input));
      const logged = JSON.stringify(warn.mock.calls);
      warn.mockRestore();
      expect(logged).toContain('c1');
      expect(logged).toContain('工具');
      expect(logged).not.toContain('Bash'); // 工具名稱來自模型輸出，可能被注入內容
      expect(logged).not.toContain('狗糧');
      expect(logged).not.toContain(TOKEN);
    });

    it('additional_directories 可以不存在：token 錯誤時 CLI 就不回報這個欄位', async () => {
      const f = fake({
        init: { additional_directories: null },
        lines: [res('ok')],
      });
      expect(lastOf(await collect(runner(f.bin).run(input))).type).toBe('done');
    });

    it('還沒收到 init 就有內容，視同違規', async () => {
      const f = fake({
        init: null,
        lines: [delta('不該看到'), res('不該看到')],
        hang: true,
      });
      const events = await collect(runner(f.bin).run(input));
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'isolation_violation' }),
      ]);
    });

    it('StructuredOutput 只有帶 schema 時才放行', async () => {
      const lines = [res('{}', { structured_output: { decision: 'listen' } })];
      const init = { tools: ['StructuredOutput'] };
      const withSchema = await collect(
        runner(fake({ init, lines }, 'a').bin).run({
          ...input,
          jsonSchema: { type: 'object' },
        }),
      );
      const without = await collect(
        runner(fake({ init, lines }, 'b').bin).run(input),
      );
      expect(lastOf(withSchema)).toMatchObject({
        type: 'done',
        structured: { decision: 'listen' },
      });
      expect(lastOf(without)).toMatchObject({
        type: 'error',
        code: 'isolation_violation',
      });
    });
  });

  describe('取消', () => {
    it('先送 SIGINT，回傳 cancelled，並刪除目錄', async () => {
      const f = fake({ lines: [delta('一')], hang: true });
      const run = runner(f.bin).run(input);
      const events: LlmEvent[] = [];
      for await (const e of run) {
        events.push(e);
        if (e.type === 'text') run.cancel();
      }
      const r = f.report();
      expect(r.signals).toEqual(['SIGINT']);
      expect(lastOf(events)).toMatchObject({
        type: 'error',
        code: 'cancelled',
      });
      expect(existsSync(r.cwd)).toBe(false);
    });

    it('SIGINT 沒反應時，逾時送 SIGKILL', async () => {
      const f = fake({ lines: [delta('一')], hang: true, ignoreSigint: true });
      const run = runner(f.bin, { killGraceMs: 50 }).run(input);
      const events: LlmEvent[] = [];
      for await (const e of run) {
        events.push(e);
        if (e.type === 'text') run.cancel();
      }
      const r = f.report();
      expect(r.signals).toEqual(['SIGINT']);
      expect(lastOf(events)).toMatchObject({
        type: 'error',
        code: 'cancelled',
      });
      expect(() => process.kill(r.pid, 0)).toThrow();
    });

    it('開始前就取消，不啟動程序', async () => {
      const f = fake({ lines: [res('x')] });
      const run = runner(f.bin).run(input);
      run.cancel();
      expect(await collect(run)).toEqual([
        expect.objectContaining({ code: 'cancelled' }),
      ]);
      expect(f.reported()).toBe(false);
    });

    it('拿到名額的同時被取消，不啟動程序，名額也還回去', async () => {
      const f = fake({ lines: [res('x')] });
      const r = runner(f.bin);
      const release = vi.fn();
      const run = r.run(input);
      // 兩者之間沒有可以插入的時間點，只能換掉 limiter 來重現
      (r as unknown as { limiter: unknown }).limiter = {
        acquire: async () => {
          run.cancel();
          return release;
        },
      };
      expect(await collect(run)).toEqual([
        expect.objectContaining({ code: 'cancelled' }),
      ]);
      expect(f.reported()).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    });

    it('等待啟動途中被取消，不啟動程序', async () => {
      const f = fake({ lines: [res('x')] });
      const r = runner(f.bin);
      const run = r.run(input);
      (r as unknown as { limiter: unknown }).limiter = {
        acquire: async () => {
          setImmediate(() => run.cancel()); // 落在建立暫存目錄的途中
          return () => undefined;
        },
      };
      expect(await collect(run)).toEqual([
        expect.objectContaining({ code: 'cancelled' }),
      ]);
      expect(f.reported()).toBe(false);
    });

    it('已經收到結果，但程序還沒結束時取消：回傳 cancelled，不送出過期的回答', async () => {
      const f = fake({
        lines: [res('過期的回答')],
        hang: true,
        ignoreSigint: true,
      });
      const run = runner(f.bin, { killGraceMs: 300 }).run(input);
      const next = run[Symbol.asyncIterator]().next();
      await new Promise((d) => setTimeout(d, 150));
      run.cancel();
      expect((await next).value).toMatchObject({
        type: 'error',
        code: 'cancelled',
      });
    });

    it('自立門戶（setsid）的子程序佔住 stdout：有時限地結束，不會永遠卡住', async () => {
      const f = fake({
        lines: [delta('一')],
        hang: true,
        descendant: 'setsid',
      });
      const run = runner(f.bin, { killGraceMs: 50 }).run(input);
      const events: LlmEvent[] = [];
      for await (const e of run) {
        events.push(e);
        if (e.type === 'text') run.cancel();
      }
      const r = f.report();
      process.kill(r.descendantPid, 'SIGKILL'); // 收不到的那個，由測試自己清
      expect(lastOf(events)).toMatchObject({ code: 'cancelled' });
      expect(existsSync(r.cwd)).toBe(false);
    }, 4000);

    it('CLI 正常結束後，同一組還活著的子程序也會被清掉', async () => {
      const f = fake({ lines: [res('ok')], hang: true, descendant: 'quiet' });
      await collect(runner(f.bin).run(input));
      await new Promise((d) => setTimeout(d, 50));
      expect(() => process.kill(f.report().descendantPid, 0)).toThrow();
    });

    it('子程序佔住 stdout 也不會卡住，而且一起被清掉', async () => {
      const f = fake({ lines: [delta('一')], hang: true, descendant: true });
      const run = runner(f.bin).run(input);
      const events: LlmEvent[] = [];
      for await (const e of run) {
        events.push(e);
        if (e.type === 'text') run.cancel();
      }
      expect(lastOf(events)).toMatchObject({ code: 'cancelled' });
      await new Promise((r) => setTimeout(r, 50));
      expect(() => process.kill(f.report().descendantPid, 0)).toThrow();
    }, 8000);

    it('超過總時限就結束，不會永遠佔著名額', async () => {
      const f = fake({ lines: [delta('一')], hang: true });
      const events = await collect(runner(f.bin, { maxRunMs: 100 }).run(input));
      expect(lastOf(events)).toMatchObject({ type: 'error', code: 'unknown' });
      expect(existsSync(f.report().cwd)).toBe(false);
    });

    it('消費端提早離開也會結束程序並刪除目錄', async () => {
      const f = fake({ lines: [delta('一')], hang: true });
      for await (const e of runner(f.bin).run(input)) {
        if (e.type === 'text') break;
      }
      const r = f.report();
      expect(existsSync(r.cwd)).toBe(false);
      expect(() => process.kill(r.pid, 0)).toThrow();
    });
  });

  describe('錯誤', () => {
    it('最後一個事件出來時，程序和目錄都已經清掉：消費端不用再多讀一次', async () => {
      const f = fake({ lines: [res('ok')] });
      const it1 = runner(f.bin).run(input)[Symbol.asyncIterator]();
      expect((await it1.next()).value).toMatchObject({ type: 'done' });
      const r = f.report();
      expect(existsSync(r.cwd)).toBe(false);
      expect(() => process.kill(r.pid, 0)).toThrow();
    });

    it('同步拋錯（參數有 NUL）也回傳 error 事件，不是讓 iterator 爆掉', async () => {
      const f = fake({ lines: [res('ok')] });
      const events = await collect(
        runner(f.bin).run({ ...input, system: 'a\0b' }),
      );
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'unknown' }),
      ]);
    });

    it('錯誤訊息是固定文字，不轉傳 CLI 的輸出', async () => {
      const f = fake({
        lines: [res('客戶資料 A123', { is_error: true })],
        exit: 1,
      });
      const events = await collect(runner(f.bin).run(input));
      expect(JSON.stringify(events)).not.toContain('A123');
    });

    it('401 回傳 auth，訊息不含 token', async () => {
      const f = fake({
        lines: [
          res(`Failed to authenticate ${TOKEN}`, {
            is_error: true,
            api_error_status: 401,
          }),
        ],
        exit: 1,
      });
      const events = await collect(runner(f.bin).run(input));
      expect(lastOf(events)).toMatchObject({ type: 'error', code: 'auth' });
      expect(JSON.stringify(events)).not.toContain(TOKEN);
      expect(existsSync(f.report().cwd)).toBe(false);
    });

    it('沒有 result 就結束時看 stderr，訊息也不含 token', async () => {
      const f = fake({
        lines: [],
        stderr: `Not logged in, token ${TOKEN}`,
        exit: 1,
      });
      const events = await collect(runner(f.bin).run(input));
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'auth' }),
      ]);
      expect(JSON.stringify(events)).not.toContain(TOKEN);
    });

    it('429 回傳 rate_limit', async () => {
      const f = fake({
        lines: [res('limit', { is_error: true, api_error_status: 429 })],
        exit: 1,
      });
      expect(lastOf(await collect(runner(f.bin).run(input)))).toMatchObject({
        type: 'error',
        code: 'rate_limit',
      });
    });

    it('其他失敗回傳 unknown', async () => {
      const f = fake({ lines: [], exit: 3 });
      expect(await collect(runner(f.bin).run(input))).toEqual([
        expect.objectContaining({ type: 'error', code: 'unknown' }),
      ]);
    });

    it('找不到執行檔回傳 unknown', async () => {
      const events = await collect(runner(join(dir, 'missing')).run(input));
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'unknown' }),
      ]);
    });
  });

  describe('工具事件', () => {
    it('工具呼叫和結果都帶工具名稱；StructuredOutput 不算工具呼叫', async () => {
      const use = (id: string, name: string, toolInput: unknown) => ({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id, name, input: toolInput }],
        },
      });
      const back = (id: string, isError?: boolean) => ({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              is_error: isError,
              content: 'x',
            },
          ],
        },
      });
      const f = fake({
        init: {
          tools: ['mcp__support__echo', 'StructuredOutput'],
          mcp_servers: [{ name: 'support', status: 'connected' }],
        },
        lines: [
          use('t1', 'mcp__support__echo', { text: 'a' }),
          back('t1'),
          use('t2', 'mcp__support__echo', { text: 'b' }),
          back('t2', true),
          use('t3', 'StructuredOutput', {}),
          back('t3'),
          res('ok'),
        ],
      });
      const events = await collect(
        runner(f.bin).run({
          ...input,
          jsonSchema: {},
          mcp: { url: 'http://x', token: 't', allowedTools: ['echo'] },
        }),
      );
      expect(events.filter((e) => e.type !== 'done')).toEqual([
        { type: 'tool_call', name: 'mcp__support__echo', input: { text: 'a' } },
        { type: 'tool_result', name: 'mcp__support__echo', isError: false },
        { type: 'tool_call', name: 'mcp__support__echo', input: { text: 'b' } },
        { type: 'tool_result', name: 'mcp__support__echo', isError: true },
      ]);
    });
  });

  describe('同時執行上限', () => {
    it('超過上限時排隊，前一個結束才啟動', async () => {
      const first = fake({ lines: [delta('一'), res('一')] }, 'first');
      const shared = runner(first.bin, { maxConcurrent: 1 });
      const it1 = shared.run(input)[Symbol.asyncIterator]();
      await it1.next(); // 第一個卡在串流中
      const secondRun = shared.run(input);
      const secondEvents = collect(secondRun);
      await new Promise((r) => setTimeout(r, 100));
      expect(
        readdirSync(tmpdir()).filter((n) => n.startsWith('llm-run-')),
      ).toHaveLength(1); // 第二個還沒建目錄
      while (!(await it1.next()).done);
      expect(lastOf(await secondEvents).type).toBe('done');
    });

    const finishers: [
      string,
      Record<string, unknown>,
      (r: AsyncIterable<LlmEvent> & { cancel(): void }) => Promise<unknown>,
    ][] = [
      ['成功', { lines: [res('ok')] }, collect],
      ['違規', { init: { tools: ['Bash'] }, lines: [], hang: true }, collect],
      ['失敗', { lines: [], exit: 1 }, collect],
      [
        '提早離開',
        { lines: [delta('一')], hang: true },
        async (r) => {
          for await (const _ of r) break;
        },
      ],
    ];

    it.each(finishers)('%s之後名額會還回來', async (_name, script, finish) => {
      const r = runner(fake(script, 'one').bin, { maxConcurrent: 1 });
      await finish(r.run(input));
      // 同一個 runner 再跑一次要能拿到名額
      const again = await Promise.race([
        finish(r.run(input)).then(() => 'ran'),
        new Promise((d) => setTimeout(() => d('stuck'), 2000)),
      ]);
      expect(again).toBe('ran');
    });

    it('取消排隊中的執行後，它的位置不會佔走名額', async () => {
      const f = fake({ lines: [delta('一'), res('一')] });
      const r = runner(f.bin, { maxConcurrent: 1 });
      const it1 = r.run(input)[Symbol.asyncIterator]();
      await it1.next();
      const cancelled = r.run(input);
      const cancelledEvents = collect(cancelled);
      await new Promise((d) => setTimeout(d, 20));
      cancelled.cancel();
      await cancelledEvents;
      const third = collect(r.run(input));
      while (!(await it1.next()).done);
      expect(lastOf(await third).type).toBe('done');
    });

    it('取消排隊中的執行不會啟動程序', async () => {
      const f = fake({ lines: [delta('一')], hang: true }, 'holder');
      const r = runner(f.bin, { maxConcurrent: 1 });
      const holder = r.run(input);
      const it1 = holder[Symbol.asyncIterator]();
      await it1.next();
      const firstPid = f.report().pid;
      const queued = r.run(input);
      const queuedEvents = collect(queued);
      await new Promise((res) => setTimeout(res, 50));
      queued.cancel();
      expect(await queuedEvents).toEqual([
        expect.objectContaining({ type: 'error', code: 'cancelled' }),
      ]);
      expect(f.report().pid).toBe(firstPid); // 報告檔沒被第二個程序覆寫
      holder.cancel();
      while (!(await it1.next()).done);
    });
  });

  describe('排隊長度上限', () => {
    it('排隊滿了直接回 busy，不會無限排隊，也不佔名額', async () => {
      const f = fake({ lines: [delta('一')], hang: true }, 'holder');
      const r = runner(f.bin, { maxConcurrent: 1, maxQueue: 1 });
      const holder = r.run(input)[Symbol.asyncIterator]();
      await holder.next();
      const queued = r.run(input)[Symbol.asyncIterator]();
      const queuedFirst = queued.next(); // 排第一個
      await new Promise((d) => setTimeout(d, 20));
      expect(await collect(r.run(input))).toEqual([
        expect.objectContaining({ type: 'error', code: 'busy' }),
      ]);
      await holder.return?.(undefined);
      // 前一個結束後，排隊中的拿到名額開始執行；被拒的那個沒有佔掉位置
      expect((await queuedFirst).value).toMatchObject({ type: 'text' });
      await queued.return?.(undefined);
    });
  });
});
