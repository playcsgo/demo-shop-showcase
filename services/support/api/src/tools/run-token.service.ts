import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/** join：Join 自動查證。查詢重點從客戶訊息整理出來，所以比客服自己問的少了 find_customer */
export type ToolRole = 'anonymous' | 'customer' | 'agent' | 'join';

/** 每次 AI 執行的權限。客戶 ID 由伺服器放進來，模型無法傳入 */
export interface RunContext {
  runId: string;
  conversationId: string;
  role: ToolRole;
  customerId: number | null;
  agentId: number | null;
}

/**
 * 每次執行發一個短期 token，綁定這次的脈絡。放記憶體：只有這台服務自己的 CLI 會用，
 * 重啟時進行中的執行本來就會中斷
 */
@Injectable()
export class RunTokenService {
  private readonly tokens = new Map<
    string,
    { ctx: RunContext; expiresAt: number }
  >();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(ctx: RunContext): string {
    const now = this.now();
    for (const [t, v] of this.tokens)
      if (v.expiresAt <= now) this.tokens.delete(t);
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, { ctx, expiresAt: now + this.ttlMs });
    return token;
  }

  verify(token: string | undefined): RunContext | null {
    const entry = token ? this.tokens.get(token) : undefined;
    if (!entry || entry.expiresAt <= this.now()) return null;
    return entry.ctx;
  }

  revoke(token: string) {
    this.tokens.delete(token);
  }

  get size() {
    return this.tokens.size;
  }
}
