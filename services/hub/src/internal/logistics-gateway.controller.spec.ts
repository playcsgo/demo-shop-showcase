import { HttpException } from '@nestjs/common';
import { PartnerRejectedError } from '../common/resilience/partner-http.js';
import type { LogisticsAdapter } from '../partners/adapters.js';
import { LogisticsGatewayController } from './logistics-gateway.controller.js';

// core-api 問預估送達時間（AIC-017）：物流商掛了回 503，不給假的預估
const ctl = (estimate: LogisticsAdapter['estimate']) => new LogisticsGatewayController({ estimate } as LogisticsAdapter);

describe('LogisticsGatewayController', () => {
  it('物流商的預估原樣回傳', async () => {
    const body = { shipping_class: 'litter', estimated_seconds: 1200, slow: true };
    await expect(ctl(async () => ({ status: 200, data: body }) as never).estimate('litter')).resolves.toEqual(body);
  });

  it('物流商回 4xx：原樣轉給 core', async () => {
    const err = await ctl(async () => { throw new PartnerRejectedError(422, { error: 'invalid_shipping_class' }); }).estimate('x').catch((e: HttpException) => e);
    expect((err as HttpException).getStatus()).toBe(422);
  });

  it('物流商掛了、逾時：503 logistics_unavailable', async () => {
    const err = await ctl(async () => { throw new Error('ECONNREFUSED'); }).estimate('litter').catch((e: HttpException) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(503);
    expect((err as HttpException).getResponse()).toEqual({ error: 'logistics_unavailable' });
  });
});
