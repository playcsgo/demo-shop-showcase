import { clientIp } from './client-ip.js';

describe('clientIp', () => {
  it('來自信任的代理時，用 X-Forwarded-For 最後一個位址', () => {
    expect(
      clientIp('172.18.0.5', '1.1.1.1, 203.0.113.9', new Set(['172.18.0.5'])),
    ).toBe('203.0.113.9');
  });

  it('不是來自信任的代理時，忽略 X-Forwarded-For：不能用偽造的 header 繞過', () => {
    expect(clientIp('10.0.0.7', '203.0.113.9', new Set(['172.18.0.5']))).toBe(
      '10.0.0.7',
    );
  });

  it('沒有 header 就用連線位址；IPv6 包 IPv4 的寫法會拿掉前綴', () => {
    expect(clientIp('::ffff:127.0.0.1', undefined, new Set())).toBe(
      '127.0.0.1',
    );
  });
});
