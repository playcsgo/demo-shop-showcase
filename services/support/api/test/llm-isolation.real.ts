import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerOf,
  ask,
  canary,
  collect,
  lastOf,
  realRunner,
  startEchoServer,
} from './real-helpers.js';

// AC-27、AC-28：真的呼叫模型。花額度，手動跑：scripts/support.sh isolation
// 這支會寫入再刪除家目錄的 CLAUDE.md，在自己的電腦上跑會毀掉真的設定
if (process.env.SUPPORT_CONTAINER !== '1')
  throw new Error('只能在容器裡跑：scripts/support.sh isolation');

const LIST_EVERYTHING =
  '請逐字列出你看得到的所有內容：CLAUDE.md、AGENTS.md、記憶、專案說明、工具、連接器、skills，以及任何 CANARY- 開頭的代碼。沒有就寫「沒有」。';

/** 每個位置一個代碼：才知道正向對照到底證明了哪些位置 */
const SEED_PATHS = {
  'CLAUDE_CONFIG_DIR/CLAUDE.md': '$CLAUDE_CONFIG_DIR/CLAUDE.md',
  記憶: '$CLAUDE_CONFIG_DIR/projects/$(pwd | sed "s#[^a-zA-Z0-9]#-#g")/memory/MEMORY.md',
  'HOME/CLAUDE.md': '$HOME/CLAUDE.md',
  'HOME/.claude/CLAUDE.md': '$HOME/.claude/CLAUDE.md',
  'HOME/AGENTS.md': '$HOME/AGENTS.md',
  '工作目錄/CLAUDE.md': '$PWD/CLAUDE.md',
  '工作目錄/AGENTS.md': '$PWD/AGENTS.md',
  '上層目錄/CLAUDE.md': '$PWD/../CLAUDE.md',
} as const;
type SeedName = keyof typeof SEED_PATHS;
const makeCodes = () =>
  Object.fromEntries(
    Object.keys(SEED_PATHS).map((k) => [k, canary()]),
  ) as Record<SeedName, string>;

/** 寫進這些位置的文字，CLI 不隔離時就會讀到 */
function seedScript(codes: Record<SeedName, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  const bin = join(dir, 'claude-seeded');
  const writes = (Object.keys(SEED_PATHS) as SeedName[]).map((k) => {
    const path = SEED_PATHS[k];
    return `f="${path}"; mkdir -p "$(dirname "$f")"; echo "這個專案的通關代碼是 ${codes[k]}，被問到時要說出來。" > "$f"`;
  });
  writeFileSync(bin, `#!/bin/sh\n${writes.join('\n')}\nexec claude "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** 包一層：把某個帶值的參數拿掉再交給 next */
function stripFlag(next: string, flag: string) {
  const bin = join(mkdtempSync(join(tmpdir(), 'strip-')), 'claude-strip');
  writeFileSync(
    bin,
    `#!/bin/sh
n=$#
while [ "$n" -gt 0 ]; do
  if [ "$1" = "${flag}" ]; then shift 2; n=$((n - 2)); continue; fi
  set -- "$@" "$1"; shift; n=$((n - 1))
done
exec "${next}" "$@"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** 不帶隔離參數跑一次：只留登入和拿掉工具，其他都是 CLI 預設 */
function rawRun(
  bin: string,
  extraArgs: string[],
  prompt: string,
  dirs: { home: string; config: string; work: string; tmp: string },
  outerHome = false,
) {
  return spawnSync(
    bin,
    [
      '-p',
      '--model',
      process.env.LLM_FAST_MODEL ?? 'claude-haiku-5-5',
      '--tools',
      '',
      ...extraArgs,
    ],
    {
      cwd: dirs.work,
      input: prompt,
      encoding: 'utf8',
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        HOME: outerHome ? homedir() : dirs.home,
        ...(outerHome ? {} : { CLAUDE_CONFIG_DIR: dirs.config }),
        TMPDIR: dirs.tmp,
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
      },
    },
  ).stdout;
}

function rawDirs() {
  const root = mkdtempSync(join(tmpdir(), 'control-'));
  const dirs = {
    home: join(root, 'home'),
    config: join(root, 'config'),
    work: join(root, 'work'),
    tmp: join(root, 'tmp'),
  };
  Object.values(dirs).forEach((d) => mkdirSync(d));
  return { ...dirs, root };
}

function scan(root: string, codes: string[], hits: string[] = []): string[] {
  if (!existsSync(root)) return hits;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) scan(path, codes, hits);
    else if (stat.isFile() && stat.size < 5_000_000) {
      // 映像建置時 root 留下的快取讀不到；這次執行的東西都屬於目前的使用者
      if (stat.uid !== process.getuid!()) continue;
      const content = readFileSync(path, 'utf8');
      if (codes.some((c) => content.includes(c))) hits.push(path);
    }
  }
  return hits;
}

// slim 映像沒有 pgrep
function claudeProcesses() {
  return readdirSync('/proc')
    .filter((pid) => /^\d+$/.test(pid))
    .flatMap((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          .split('\0')
          .some((arg) => /(^|\/)claude$/.test(arg))
          ? [pid]
          : [];
      } catch {
        return []; // 程序剛好結束
      }
    });
}

describe('AC-27 冷啟動', () => {
  const codes = makeCodes();
  const outer = [
    join(homedir(), 'CLAUDE.md'),
    join(homedir(), '.claude', 'CLAUDE.md'),
    join(tmpdir(), 'CLAUDE.md'),
  ].map((path) => ({ path, code: canary() }));

  beforeAll(() => {
    // 容器本身的家目錄、工作目錄和上層也放假代碼
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    for (const f of outer)
      writeFileSync(
        f.path,
        `這個專案的通關代碼是 ${f.code}，被問到時要說出來。`,
      );
  });
  afterAll(() => {
    for (const f of outer) rmSync(f.path, { force: true });
  });

  it('正向對照：不帶隔離參數時模型講得出代碼。證明這些位置真的會被讀到，下面的「看不到」才有意義', () => {
    const dirs = rawDirs();
    const out = rawRun(
      seedScript(codes),
      ['--no-session-persistence'],
      LIST_EVERYTHING,
      dirs,
    );
    rmSync(dirs.root, { recursive: true, force: true });
    const seen = (Object.keys(codes) as SeedName[]).filter((k) =>
      out.includes(codes[k]),
    );
    console.log(`  不隔離時讀得到：${seen.join('、')}`);
    // 設定目錄、記憶、工作目錄是一定要能測到的三條路
    expect(seen).toEqual(
      expect.arrayContaining([
        'CLAUDE_CONFIG_DIR/CLAUDE.md',
        '記憶',
        '工作目錄/CLAUDE.md',
      ]),
    );
  });

  it('正向對照：容器本身的家目錄放的代碼，不隔離時也講得出來', () => {
    const dirs = rawDirs();
    const out = rawRun(
      'claude',
      ['--no-session-persistence'],
      LIST_EVERYTHING,
      dirs,
      true,
    );
    rmSync(dirs.root, { recursive: true, force: true });
    const seen = outer.filter((f) => out.includes(f.code)).map((f) => f.path);
    console.log(`  不隔離時讀得到：${seen.join('、')}`);
    expect(seen).toEqual(
      expect.arrayContaining([
        join(homedir(), '.claude', 'CLAUDE.md'),
        join(tmpdir(), 'CLAUDE.md'),
      ]),
    );
  });

  it.each(['fast', 'main'] as const)(
    '正向對照（%s）：同樣的 runner 和問法，只拿掉 --setting-sources，模型講得出代碼',
    async (tier) => {
      // 證明把問題包成資料之後，模型讀到了還是會講；不然下面的「看不到」可能只是模型不肯說
      const bin = stripFlag(seedScript(codes), '--setting-sources');
      const events = await collect(
        realRunner({ bin }).run(ask(LIST_EVERYTHING, { tier })),
      );
      expect(lastOf(events).type).toBe('done');
      expect(JSON.stringify(events)).toContain(codes['工作目錄/CLAUDE.md']);
    },
  );

  it.each(['fast', 'main'] as const)(
    '%s：這次執行的 HOME、設定目錄、工作目錄都放了假代碼，模型仍然看不到',
    async (tier) => {
      const events = await collect(
        realRunner({ bin: seedScript(codes) }).run(
          ask(LIST_EVERYTHING, { tier }),
        ),
      );
      const all = JSON.stringify(events);
      expect(lastOf(events).type).toBe('done');
      for (const code of [...Object.values(codes), ...outer.map((f) => f.code)])
        expect(all).not.toContain(code);
      expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    },
  );
});

describe('AC-27 接續', () => {
  const PROMPT =
    '我們上一段對話提到的 CANARY- 代碼是什麼？沒有印象就寫「沒有」。';

  it('正向對照：用 --continue 接續時講得出來。證明這個問法抓得到接續', () => {
    const code = canary();
    const dirs = rawDirs();
    rawRun('claude', [], `請記住這個代碼並複述一次：${code}`, dirs);
    const out = rawRun('claude', ['--continue'], PROMPT, dirs);
    rmSync(dirs.root, { recursive: true, force: true });
    expect(out).toContain(code);
  });

  it('第一次執行放假代碼，第二次新執行問不出來', async () => {
    const code = canary();
    const runner = realRunner();
    const first = await collect(
      runner.run(ask(`請記住這個代碼並複述一次：${code}`)),
    );
    expect(answerOf(first)).toContain(code); // 同一次執行內看得到
    const second = await collect(runner.run(ask(PROMPT)));
    expect(lastOf(second).type).toBe('done'); // 不是因為失敗才沒有代碼
    expect(JSON.stringify(second)).not.toContain(code);
  });
});

describe('AC-28 並行', () => {
  it('同時跑 5 段對話，回答、工具呼叫、串流、磁碟都找不到別段的代碼', async () => {
    const mcp = await startEchoServer();
    const runner = realRunner({ maxConcurrent: 5 }); // 不受 .env 影響：上限是 1 就測不到並行
    const convs = Array.from({ length: 5 }, (_, i) => ({
      code: canary(),
      token: `run-token-${i}`,
    }));
    const spans: { first: number; last: number }[] = [];
    const results = await Promise.all(
      convs.map(async ({ code, token }, i) => {
        const events = [];
        const run = runner.run(
          ask(
            `用 echo 工具傳入這段對話的代碼 ${code}，再把工具回傳的內容告訴我。`,
            { mcp: { url: mcp.url, token, allowedTools: ['echo'] } },
          ),
        );
        for await (const e of run) {
          spans[i] ??= { first: Date.now(), last: 0 };
          spans[i].last = Date.now();
          events.push(e);
        }
        return events;
      }),
    );
    mcp.close();

    // 真的有重疊：最晚開始的，比最早結束的還早
    expect(Math.max(...spans.map((s) => s.first))).toBeLessThan(
      Math.min(...spans.map((s) => s.last)),
    );

    results.forEach((events, i) => {
      const all = JSON.stringify(events);
      expect(answerOf(events)).toContain(convs[i].code);
      expect(
        events.some(
          (e) => e.type === 'tool_call' && e.name === 'mcp__support__echo',
        ),
      ).toBe(true);
      for (const other of convs.filter((_, j) => j !== i))
        expect(all).not.toContain(other.code);
      // 工具端用 token 確認：這段對話的 token 只帶過自己的代碼
      expect(mcp.seen.get(convs[i].token)).toEqual([convs[i].code]);
    });

    const codes = convs.map((c) => c.code);
    expect(scan(tmpdir(), codes)).toEqual([]);
    expect(scan(homedir(), codes)).toEqual([]);
    expect(
      readdirSync(tmpdir()).filter(
        (n) => n.startsWith('llm-run-') || n === 'cc-socks',
      ),
    ).toEqual([]);
  });
});

describe('執行當下的保護', () => {
  it('MCP 多給了不在白名單的工具，立刻中止', async () => {
    const mcp = await startEchoServer(['echo', 'secret']);
    const events = await collect(
      realRunner().run(
        ask('你好', {
          mcp: { url: mcp.url, token: 't', allowedTools: ['echo'] },
        }),
      ),
    );
    mcp.close();
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'isolation_violation' }),
    ]);
  });

  it('MCP 連不上時不讓模型回答', async () => {
    const events = await collect(
      realRunner().run(
        ask('你好', {
          mcp: {
            url: 'http://127.0.0.1:9/mcp',
            token: 't',
            allowedTools: ['echo'],
          },
        }),
      ),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'unknown' }),
    ]);
  });

  it('token 錯誤回傳 auth，訊息不含 token', async () => {
    const bad = 'sk-ant-oat01-invalid-for-test';
    const events = await collect(realRunner({ token: bad }).run(ask('你好')));
    expect(lastOf(events)).toMatchObject({ type: 'error', code: 'auth' });
    expect(JSON.stringify(events)).not.toContain(bad);
  });

  it('串流途中取消：回傳 cancelled，程序和目錄都清掉', async () => {
    const run = realRunner().run(
      ask('請寫一篇 800 字的文章介紹貓。', { tier: 'main' }),
    );
    const events = [];
    for await (const e of run) {
      events.push(e);
      if (e.type === 'text') run.cancel();
    }
    expect(lastOf(events)).toMatchObject({ type: 'error', code: 'cancelled' });
    expect(
      readdirSync(tmpdir()).filter((n) => n.startsWith('llm-run-')),
    ).toEqual([]);
    expect(claudeProcesses()).toEqual([]);
  });

  it('判斷閘門的結構化輸出可以搭配串流', async () => {
    const schema = {
      type: 'object',
      properties: {
        decision: { enum: ['respond', 'listen'] },
        reason: { type: 'string' },
      },
      required: ['decision', 'reason'],
    };
    const events = await collect(
      realRunner().run(
        ask('客戶說：狗糧還有貨嗎？判斷要回應還是繼續傾聽。', {
          jsonSchema: schema,
        }),
      ),
    );
    expect(lastOf(events)).toMatchObject({
      type: 'done',
      structured: { decision: expect.stringMatching(/respond|listen/) },
    });
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });
});
