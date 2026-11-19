export interface LlmMessage {
  role: 'customer' | 'agent' | 'assistant' | 'system_note';
  text: string;
}

export interface LlmRunInput {
  conversationId: string; // 只用於記錄和假代碼測試，不會讓 CLI 找回舊對話
  tier: 'fast' | 'main'; // fast＝判斷閘門，main＝主回答
  system: string;
  messages: LlmMessage[];
  mcp?: { url: string; token: string; allowedTools: string[] };
  jsonSchema?: object; // 判斷閘門要結構化輸出
}

export type LlmErrorCode =
  | 'isolation_violation'
  | 'auth'
  | 'rate_limit'
  | 'busy' // 排隊已滿
  | 'cancelled'
  | 'unknown';

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; isError: boolean }
  | {
      type: 'done';
      text: string;
      structured?: unknown;
      usage: { initMs: number | null; ttftMs: number | null; totalMs: number };
    }
  | { type: 'error'; code: LlmErrorCode; message: string };

/** 要讀到結束或 break，程序和暫存目錄才會清掉。最後一個事件一定是 done 或 error */
export interface LlmRun extends AsyncIterable<LlmEvent> {
  cancel(): void;
}

export interface LlmRunner {
  run(input: LlmRunInput): LlmRun;
}
