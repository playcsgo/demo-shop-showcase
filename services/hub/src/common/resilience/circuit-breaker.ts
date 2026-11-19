import { scaled } from '../time.js';
/**
 * 斷路器（§7）：連續失敗太多次就「斷開」，一段時間內直接拒絕，不再打已經掛掉的廠商。
 *
 *   CLOSED（正常）──連續失敗 N 次──▶ OPEN（直接拒絕）
 *      ▲                                 │ 等 openMs
 *      └──試打成功── HALF_OPEN（放一個請求試試）◀┘
 *                        └──試打失敗──▶ OPEN
 *
 * 好處：廠商掛掉時不會每個請求都等到逾時，自己的 worker 和連線不會被拖垮；也給對方喘息的時間。
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor(public readonly partner: string) {
    super(`circuit open: ${partner}`);
  }
}

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;

  constructor(
    public readonly name: string,
    private readonly failureThreshold = 5,
    private readonly openMs = scaled(10_000),   // 冷卻時間也跟著時間壓縮
  ) {}

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt < this.openMs) throw new CircuitOpenError(this.name);
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'CLOSED';
      return result;
    } catch (e) {
      this.failures++;
      if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
        this.state = 'OPEN';
        this.openedAt = Date.now();
      }
      throw e;
    }
  }

  snapshot() {
    return { name: this.name, state: this.state, failures: this.failures };
  }
}
