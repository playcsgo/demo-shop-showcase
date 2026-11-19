import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { PartnerHttp, PartnerRejectedError, PartnerUnavailableError } from './partner-http.js';

/** 起一個真的 HTTP server，依序回傳指定的狀態碼 */
function fakePartner(statuses: number[]): Promise<{ server: Server; url: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((_req, res) => {
    const status = statuses[Math.min(calls++, statuses.length - 1)];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ status }));
  });
  return new Promise((r) => server.listen(0, () => r({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => calls })));
}

describe('PartnerHttp', () => {
  it('5xx 會重試，第 3 次成功就回傳', async () => {
    const p = await fakePartner([500, 503, 200]);
    const http = new PartnerHttp('x', p.url, { timeoutMs: 1000, attempts: 3, baseDelayMs: 1 });

    await expect(http.request('POST', '/charges', {})).resolves.toMatchObject({ status: 200 });
    expect(p.calls()).toBe(3);
    p.server.close();
  });

  it('4xx 是確定的拒絕：不重試、也不讓斷路器計入失敗', async () => {
    const p = await fakePartner([409]);
    const http = new PartnerHttp('x', p.url, { timeoutMs: 1000, attempts: 3, baseDelayMs: 1 });

    for (let i = 0; i < 6; i++) await expect(http.request('POST', '/bookings', {})).rejects.toBeInstanceOf(PartnerRejectedError);
    expect(p.calls()).toBe(6);                         // 每次只打 1 次
    expect(http.breaker.snapshot().state).toBe('CLOSED'); // 醫院額滿不代表醫院掛了
    p.server.close();
  });

  it('一直 5xx：重試用完丟出 PartnerUnavailableError（由 SQS 稍後重送）', async () => {
    const p = await fakePartner([500]);
    const http = new PartnerHttp('x', p.url, { timeoutMs: 1000, attempts: 3, baseDelayMs: 1 });

    await expect(http.request('POST', '/charges', {})).rejects.toBeInstanceOf(PartnerUnavailableError);
    expect(p.calls()).toBe(3);
    p.server.close();
  });
});
