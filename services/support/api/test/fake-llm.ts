import type {
  LlmEvent,
  LlmRun,
  LlmRunInput,
  LlmRunner,
} from '../src/llm/llm.types.js';

export type Step =
  | { json: unknown }
  | { delayMs: number }
  | { tool: string; args?: Record<string, unknown> }
  | { text: string }
  | { error: 'busy' | 'unknown' | 'rate_limit' }
  | { hang: true };

/**
 * 假的 LLM：照腳本走，遇到工具步驟時真的拿 run token 去打 /mcp，
 * 和真的 CLI 走同一條路，只有模型是假的。記錄每次收到的輸入和是否被取消
 */
export class FakeLlm implements LlmRunner {
  readonly inputs: LlmRunInput[] = []; // 主模型（Ask）的呼叫
  readonly fastInputs: LlmRunInput[] = []; // 快速模型（路由、摘要）的呼叫
  readonly cancelled: string[] = [];
  readonly toolResults: { name: string; content: string; isError: boolean }[] =
    [];
  script: (input: LlmRunInput) => Step[] = () => [{ text: '好的' }];
  /** 路由判斷（快速模型＋JSON schema）的回答；預設是一般問題，不影響 Ask 的測試 */
  route: (input: LlmRunInput) => Step[] = () => [
    { json: { intent: 'normal', reason: '測試' } },
  ];
  /** Join 判斷閘門的回答；預設保持安靜 */
  gate: (input: LlmRunInput) => Step[] = () => [
    { json: { action: 'listen', reason: '測試', query: '' } },
  ];
  readonly gateInputs: LlmRunInput[] = [];
  /** 摘要（快速模型、沒有 schema）的回答 */
  summary: (input: LlmRunInput) => Step[] = () => [{ text: '客戶想了解商品' }];

  run(input: LlmRunInput): LlmRun {
    const abort = new AbortController();
    let steps: Step[];
    if (input.tier === 'fast') {
      this.fastInputs.push(input);
      if (input.system.startsWith('【Join】')) {
        this.gateInputs.push(input);
        steps = this.gate(input);
      } else steps = input.jsonSchema ? this.route(input) : this.summary(input);
    } else {
      this.inputs.push(input);
      steps = this.script(input);
    }
    const { toolResults, cancelled } = this;
    async function* events(): AsyncGenerator<LlmEvent> {
      let text = '';
      let structured: unknown;
      for (const step of steps) {
        if (abort.signal.aborted) break;
        if ('tool' in step) {
          yield {
            type: 'tool_call',
            name: `mcp__support__${step.tool}`,
            input: step.args ?? {},
          };
          const res = await fetch(input.mcp!.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${input.mcp!.token}`,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: step.tool, arguments: step.args ?? {} },
            }),
          });
          const body = res.status === 200 ? await res.json() : null;
          const content =
            body?.result?.content?.[0]?.text ?? `HTTP ${res.status}`;
          const isError = !body || body.result.isError;
          toolResults.push({ name: step.tool, content, isError });
          yield {
            type: 'tool_result',
            name: `mcp__support__${step.tool}`,
            isError,
          };
        } else if ('text' in step) {
          for (const ch of step.text.match(/.{1,4}/gsu) ?? []) {
            text += ch;
            yield { type: 'text', delta: ch };
          }
        } else if ('delayMs' in step) {
          await new Promise((r) => setTimeout(r, step.delayMs));
        } else if ('json' in step) {
          structured = step.json;
        } else if ('error' in step) {
          yield { type: 'error', code: step.error, message: 'fake' };
          return;
        } else {
          await new Promise<void>((resolve) =>
            abort.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
        }
      }
      if (abort.signal.aborted) {
        cancelled.push(input.conversationId);
        yield { type: 'error', code: 'cancelled', message: '已取消' };
        return;
      }
      yield {
        type: 'done',
        text,
        ...(structured !== undefined ? { structured } : {}),
        usage: { initMs: 1, ttftMs: 1, totalMs: 2 },
      };
    }
    const it = events();
    return { [Symbol.asyncIterator]: () => it, cancel: () => abort.abort() };
  }
}
