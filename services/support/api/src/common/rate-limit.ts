/**
 * 固定視窗計數。放在記憶體：demo 只有一台；多台時換成 Redis，介面不變。
 * 每次 hit 時順手清掉過期的 key，不會無限長大
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): boolean {
    const now = this.now();
    for (const [k, w] of this.windows)
      if (now - w.start >= this.windowMs) this.windows.delete(k);
    const w = this.windows.get(key) ?? { start: now, count: 0 };
    w.count++;
    this.windows.set(key, w);
    return w.count <= this.limit;
  }

  get size() {
    return this.windows.size;
  }
}
