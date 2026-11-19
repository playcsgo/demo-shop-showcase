import { Logger } from '@nestjs/common';
import { currentCorrelationId } from '../correlation.js';
import { metrics } from '../metrics.js';
import { scaled } from '../time.js';
import { CircuitBreaker } from './circuit-breaker.js';

/** 廠商回了「確定的」錯誤（4xx）：重試也沒用，例如付款被拒、醫院額滿 */
export class PartnerRejectedError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`partner rejected: ${status}`);
  }
}

/** 暫時性錯誤（5xx、逾時、斷線、斷路器打開）：可以重試 */
export class PartnerUnavailableError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 呼叫外部廠商的標準流程（§7 C1）：
 *   逾時（5 s）→ 指數退避＋抖動重試（最多 3 次）→ 斷路器
 * 冪等鍵由呼叫端放在 body 裡，重試不會重複扣款。
 */
export class PartnerHttp {
  /** 所有實例（/health 回報壓縮後最短的逾時，給 sandbox 的時間檢查用） */
  static readonly all: PartnerHttp[] = [];
  readonly breaker: CircuitBreaker;
  private readonly logger = new Logger('PartnerHttp');
  readonly opts: { timeoutMs: number; attempts: number; baseDelayMs: number };

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    opts = { timeoutMs: 5000, attempts: 3, baseDelayMs: 200 },
  ) {
    // 逾時、重試間隔跟著時間壓縮（common/time.ts）；重試次數不變
    this.opts = { ...opts, timeoutMs: scaled(opts.timeoutMs), baseDelayMs: scaled(opts.baseDelayMs) };
    this.breaker = new CircuitBreaker(name);
    PartnerHttp.all.push(this);
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: T }> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.opts.attempts; attempt++) {
      const started = Date.now();
      const before = this.breaker.snapshot().state;
      const call = { partner: this.name, method, path, attempt };
      try {
        // 斷路器只計算「暫時性錯誤」；4xx 在斷路器外面判斷，不會讓斷路器誤以為廠商掛了
        const res = await this.breaker.exec(() => this.once<T>(method, path, body));
        this.logBreakerChange(before);
        if (res.status >= 400) throw new PartnerRejectedError(res.status, res.data); // 確定的拒絕，不重試
        metrics.increment('demo.partner.call', 1, { partner: this.name, outcome: 'ok' });
        this.logger.debug({ ...call, status: res.status, ms: Date.now() - started }, `${this.name} ${method} ${path} → ${res.status}`);
        return res;
      } catch (e) {
        this.logBreakerChange(before);
        if (e instanceof PartnerRejectedError) {
          metrics.increment('demo.partner.call', 1, { partner: this.name, outcome: 'rejected' });
          this.logger.log({ ...call, status: e.status, body: e.body, ms: Date.now() - started }, `${this.name} rejected ${e.status} (no retry)`);
          throw e;
        }
        metrics.increment('demo.partner.call', 1, { partner: this.name, outcome: 'retryable_error' });
        this.logger.warn({ ...call, err: (e as Error).message, ms: Date.now() - started, breaker: this.breaker.snapshot().state },
          `${this.name} ${method} ${path} failed (attempt ${attempt}/${this.opts.attempts})`);
        lastError = e;
        if (attempt < this.opts.attempts) {
          const backoff = this.opts.baseDelayMs * 2 ** (attempt - 1);
          await sleep(backoff + Math.random() * backoff); // 抖動：避免大家同時重試又一起撞上去
        }
      }
    }
    throw new PartnerUnavailableError(`${this.name}: ${(lastError as Error)?.message}`);
  }

  private logBreakerChange(before: string): void {
    const now = this.breaker.snapshot();
    if (now.state !== before) this.logger.warn({ partner: this.name, from: before, to: now.state, failures: now.failures }, `circuit ${this.name}: ${before} → ${now.state}`);
  }

  private async once<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    let res: Response;
    const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' }; // 沒有 body 還宣告 JSON，Fastify 會回 400
    const correlationId = currentCorrelationId();
    if (correlationId) headers['x-correlation-id'] = correlationId; // 廠商的 log、sandbox 的故障注入都靠它對應到是哪一筆
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new PartnerUnavailableError((e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message);
    }

    const data = (await res.json().catch(() => ({}))) as T;
    if (res.status >= 500) throw new PartnerUnavailableError(`HTTP ${res.status}`);
    return { status: res.status, data }; // 4xx 也正常回傳，由 request() 判斷
  }
}
