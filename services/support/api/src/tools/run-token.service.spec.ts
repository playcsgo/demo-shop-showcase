import { RunTokenService } from './run-token.service.js';

const ctx = {
  runId: 'r1',
  conversationId: 'c1',
  role: 'customer' as const,
  customerId: 7,
  agentId: null,
};

describe('RunTokenService', () => {
  it('發出的 token 驗得回同一份脈絡；每次都不同', () => {
    const tokens = new RunTokenService();
    const a = tokens.issue(ctx);
    expect(tokens.verify(a)).toEqual(ctx);
    expect(tokens.issue(ctx)).not.toBe(a);
  });

  it('撤銷、過期、亂打的 token 都驗不過', () => {
    let now = 0;
    const tokens = new RunTokenService(1000, () => now);
    const a = tokens.issue(ctx);
    const b = tokens.issue(ctx);
    tokens.revoke(a);
    expect(tokens.verify(a)).toBeNull();
    now = 1000;
    expect(tokens.verify(b)).toBeNull();
    expect(tokens.verify('nope')).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
  });

  it('過期的 token 會被清掉', () => {
    let now = 0;
    const tokens = new RunTokenService(1000, () => now);
    for (let i = 0; i < 50; i++) tokens.issue(ctx);
    now = 2000;
    tokens.issue(ctx);
    expect(tokens.size).toBe(1);
  });
});
