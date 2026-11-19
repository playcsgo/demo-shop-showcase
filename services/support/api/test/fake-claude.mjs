// 假的 claude CLI：照腳本輸出 stream-json，並把收到的參數和環境變數寫到報告檔。
// 子程序的環境變數是白名單，所以腳本不靠環境變數傳，由 spec 產生的執行檔帶進來。
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INIT = {
  type: 'system',
  subtype: 'init',
  tools: [],
  mcp_servers: [],
  slash_commands: [],
  skills: [],
  plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' }],
  agents: ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'],
  additional_directories: [],
};

export async function main({ report, init = {}, lines = [], stderr, exit = 0, hang, ignoreSigint, splitLines, descendant }) {
  const write = (extra) => writeFileSync(report, JSON.stringify({ ...data, ...extra }));
  const data = {
    args: process.argv.slice(2),
    env: { ...process.env },
    cwd: process.cwd(),
    stdin: readFileSync(0, 'utf8'),
    pid: process.pid,
    signals: [],
  };
  const mcpIdx = data.args.indexOf('--mcp-config');
  if (mcpIdx >= 0) data.mcpConfig = readFileSync(data.args[mcpIdx + 1], 'utf8');
  write();

  // 留下真實 CLI 會留的檔案，讓 spec 確認跑完有被刪掉
  for (const dir of [process.env.HOME, process.env.CLAUDE_CONFIG_DIR, process.env.TMPDIR, process.cwd()]) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'left-behind.txt'), 'x');
  }

  process.on('SIGINT', () => {
    data.signals.push('SIGINT');
    write();
    if (!ignoreSigint) process.exit(130);
  });

  if (descendant) {
    // 模擬 CLI 的子程序。setsid：脫離 process group 又佔住 stdout；quiet：不佔 stdout、不理 SIGINT
    const code = "process.on('SIGINT', () => {}); setTimeout(() => {}, 60000)";
    const child = spawn(process.execPath, ['-e', code], {
      stdio: descendant === 'quiet' ? 'ignore' : ['ignore', 'inherit', 'inherit'],
      detached: descendant === 'setsid',
    });
    data.descendantPid = child.pid;
    write();
    await new Promise((r) => setTimeout(r, 300)); // 等它掛好 SIGINT 的處理，不然一收到就死，測不到東西
  }

  const out = [...(init === null ? [] : [{ ...INIT, cwd: process.cwd(), ...init }]), ...lines];
  for (const line of out) {
    const s = JSON.stringify(line) + '\n';
    if (splitLines) {
      // 故意切成跨 chunk 的半行
      const cut = Math.floor(s.length / 2);
      process.stdout.write(s.slice(0, cut));
      await new Promise((r) => setTimeout(r, 5));
      process.stdout.write(s.slice(cut));
    } else process.stdout.write(s);
    await new Promise((r) => setTimeout(r, 2));
  }
  if (stderr) process.stderr.write(stderr);
  if (hang) await new Promise((r) => setTimeout(r, 60_000));
  process.exitCode = exit;
}
