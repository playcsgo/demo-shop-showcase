import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Session, SessionService } from '../auth/session.service.js';
import { SessionResolveController } from './session-resolve.controller.js';

// AI 客服（support）用：拿瀏覽器帶來的 sid 問「這是哪位客戶」（AIC-015）
const alice: Session = { sid: 'sid-alice', customerId: 1, name: 'Alice', email: 'alice@example.test', token: 'JWT', tokenExp: 9e9 };
const sessions = { get: vi.fn(async (sid?: string) => (sid === 'sid-alice' ? alice : null)) } as unknown as SessionService;
const config = (key: string) => ({ get: () => key }) as unknown as ConfigService;
const ctl = (key = 'support-key') => new SessionResolveController(sessions, config(key));

describe('SessionResolveController', () => {
  it('有效的 sid：回客戶 id、名字、email，不回 core 的 JWT', async () => {
    const r = await ctl().resolve('support-key', { sid: 'sid-alice' });
    expect(r).toEqual({ valid: true, customer_id: 1, name: 'Alice', email: 'alice@example.test' });
    expect(JSON.stringify(r)).not.toContain('JWT');
  });

  it('登出或亂打的 sid：valid false', async () => {
    expect(await ctl().resolve('support-key', { sid: 'nope' })).toEqual({ valid: false });
    expect(await ctl().resolve('support-key', {})).toEqual({ valid: false });
    expect(await ctl().resolve('support-key', { sid: 'x'.repeat(500) })).toEqual({ valid: false });
  });

  it('金鑰錯、沒帶、BFF 沒設定金鑰：401', async () => {
    await expect(ctl().resolve('wrong', { sid: 'sid-alice' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(ctl().resolve(undefined, { sid: 'sid-alice' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(ctl('').resolve('', { sid: 'sid-alice' })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
