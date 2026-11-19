import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClaudeCliRunner } from '../src/llm/claude-cli.runner.js';
import { loadLlmConfig } from '../src/llm/llm.module.js';
import type { LlmEvent, LlmRunInput } from '../src/llm/llm.types.js';

export const canary = () => `CANARY-${randomUUID().slice(0, 8)}`;

export const realRunner = (
  overrides: Partial<ReturnType<typeof loadLlmConfig>> = {},
) => new ClaudeCliRunner({ ...loadLlmConfig(process.env), ...overrides });

export async function collect(run: AsyncIterable<LlmEvent>) {
  const events: LlmEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}

export const lastOf = (events: LlmEvent[]) => events[events.length - 1];
export const answerOf = (events: LlmEvent[]) => {
  const last = lastOf(events);
  if (last.type !== 'done')
    throw new Error(`沒有正常結束：${JSON.stringify(last)}`);
  return last.text;
};

export const ask = (
  text: string,
  extra: Partial<LlmRunInput> = {},
): LlmRunInput => ({
  conversationId: randomUUID(),
  tier: 'fast',
  system: '你是測試用的助理。依照要求回答，看得到什麼就照實列出。',
  messages: [{ role: 'customer', text }],
  ...extra,
});

/** 測試用 MCP：每個 token 收到過什麼都記下來，確認工具呼叫沒有跨對話 */
export function startEchoServer(toolNames = ['echo']) {
  const seen = new Map<string, string[]>();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end();
      }
      const msg = JSON.parse(body);
      const token = String(req.headers.authorization ?? '').replace(
        'Bearer ',
        '',
      );
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') {
        return reply({
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'test', version: '1' },
        });
      }
      if (msg.method === 'tools/list') {
        return reply({
          tools: toolNames.map((name) => ({
            name,
            description: 'echo text back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          })),
        });
      }
      if (msg.method === 'tools/call') {
        seen.set(token, [
          ...(seen.get(token) ?? []),
          msg.params.arguments.text,
        ]);
        return reply({
          content: [
            { type: 'text', text: `ECHO:${msg.params.arguments.text}` },
          ],
        });
      }
      if (msg.id !== undefined) {
        // 未知方法要回錯誤：CLI 連線時會先送版本探測，不回應就要白等 5 秒
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );
      }
      res.writeHead(202);
      res.end();
    });
  });
  return new Promise<{
    url: string;
    seen: Map<string, string[]>;
    close: () => void;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        seen,
        close: () => server.close(),
      });
    });
  });
}
