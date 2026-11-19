export class QueueFullError extends Error {
  constructor() {
    super('queue_full');
  }
}

/** 同時執行數上限，超過就排隊；排隊也有上限，爆量時快速失敗，不會無限排隊 */
export class RunLimiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue = Infinity,
  ) {}

  /** 拿到名額後回傳釋放函式；排隊中被取消或排隊已滿時 reject */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    if (this.running < this.max) return Promise.resolve(this.take());
    if (this.waiting.length >= this.maxQueue)
      return Promise.reject(new QueueFullError());
    return new Promise((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(this.take());
      };
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(start), 1);
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(start);
    });
  }

  private take(): () => void {
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.waiting.shift()?.();
    };
  }
}
