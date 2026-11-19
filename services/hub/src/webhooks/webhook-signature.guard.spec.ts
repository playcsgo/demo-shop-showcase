import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { WebhookSignatureGuard } from './webhook-signature.guard.js';

const SECRET = 'mockpay-secret';
const guard = new WebhookSignatureGuard(new ConfigService({ MOCKPAY_WEBHOOK_SECRET: SECRET }));

function ctx(body: string, signature: string): ExecutionContext {
  const req = { params: { provider: 'mockpay' }, rawBody: Buffer.from(body), header: () => signature };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}
const sign = (body: string, t: number, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

describe('WebhookSignatureGuard', () => {
  const body = '{"type":"charge.succeeded","order_no":"A1","amount":100}';

  it('正確的簽章：通過', () => {
    expect(guard.canActivate(ctx(body, sign(body, now())))).toBe(true);
  });

  it('body 被竄改（金額改大）：拒絕', () => {
    const tampered = body.replace('100', '999999');
    expect(() => guard.canActivate(ctx(tampered, sign(body, now())))).toThrow(UnauthorizedException);
  });

  it('用錯的金鑰簽：拒絕', () => {
    expect(() => guard.canActivate(ctx(body, sign(body, now(), 'guessed')))).toThrow(UnauthorizedException);
  });

  it('10 分鐘前的簽章（重放攻擊）：拒絕', () => {
    expect(() => guard.canActivate(ctx(body, sign(body, now() - 600)))).toThrow('stale signature');
  });
});
