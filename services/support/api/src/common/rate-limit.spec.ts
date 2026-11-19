import { FixedWindowLimiter } from './rate-limit.js';

describe('FixedWindowLimiter', () => {
  it('同一個 key 一個視窗內超過上限就拒絕，下一個視窗恢復', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(3, 60_000, () => now);
    expect([1, 2, 3, 4].map(() => limiter.hit('a'))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now = 60_000;
    expect(limiter.hit('a')).toBe(true);
  });

  it('不同 key 各自計算', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0);
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    expect(limiter.hit('b')).toBe(true);
  });

  it('過期的 key 會被清掉，不會無限長大', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 1000, () => now);
    for (let i = 0; i < 100; i++) limiter.hit(`k${i}`);
    now = 5000;
    limiter.hit('new');
    expect(limiter.size).toBe(1);
  });
});
