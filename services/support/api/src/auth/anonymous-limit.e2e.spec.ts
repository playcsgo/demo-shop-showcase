import type { INestApplication } from '@nestjs/common';
import { Client, startApp } from '../../test/http.js';

// 獨立一個 app：這個測試會把同一個來源的匿名 session 額度用完，會影響同一個 app 的其他測試
let app: INestApplication;
let url: string;
beforeAll(async () => {
  ({ app, url } = await startApp());
});
afterAll(() => app.close());

describe('匿名 session 限流', () => {
  it('同一個來源一分鐘第 21 個匿名 session 回 429；偽造 X-Forwarded-For 繞不過', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await new Client(url).post(
        '/api/auth/customer/session',
        {},
        { 'x-forwarded-for': `203.0.113.${i}` },
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
  });
});
