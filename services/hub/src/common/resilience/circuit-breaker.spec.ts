import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

const fail = () => Promise.reject(new Error('boom'));
const ok = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  it('連續失敗 5 次後打開，之後直接拒絕、不再呼叫廠商', async () => {
    const breaker = new CircuitBreaker('mockpay', 5, 10_000);
    for (let i = 0; i < 5; i++) await expect(breaker.exec(fail)).rejects.toThrow('boom');

    const spy = vi.fn(ok);
    await expect(breaker.exec(spy)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(spy).not.toHaveBeenCalled();
    expect(breaker.snapshot().state).toBe('OPEN');
  });

  it('打開一段時間後放一個請求試試：成功就恢復 CLOSED', async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker('mockpay', 1, 10_000);
    await expect(breaker.exec(fail)).rejects.toThrow();

    vi.advanceTimersByTime(10_001);
    await expect(breaker.exec(ok)).resolves.toBe('ok');
    expect(breaker.snapshot().state).toBe('CLOSED');
    vi.useRealTimers();
  });

  it('試打（HALF_OPEN）又失敗：立刻再打開', async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker('mockpay', 3, 10_000);
    for (let i = 0; i < 3; i++) await expect(breaker.exec(fail)).rejects.toThrow();

    vi.advanceTimersByTime(10_001);
    await expect(breaker.exec(fail)).rejects.toThrow('boom');
    expect(breaker.snapshot().state).toBe('OPEN');
    vi.useRealTimers();
  });
});
