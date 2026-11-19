import type { INestApplication } from '@nestjs/common';
import { Writable } from 'node:stream';
import { createApp } from '../src/app.js';
import { testEnv } from './db.js';
import { FakeLlm } from './fake-llm.js';
import { fakeShop } from './fake-shop.js';
import { fakePartners } from './fake-partners.js';
import { fakeSessions } from './shop-sessions.js';

export const ORIGIN = 'http://localhost:36173';

/** 起一個真的 app（隨機 port），log 收進記憶體讓測試檢查 */
export async function startApp(
  opts: {
    llm?: import('../src/llm/llm.types.js').LlmRunner;
    shop?: import('../src/shop/shop-client.js').ShopClient;
    sessions?: import('../src/auth/shop-session.js').ShopSessions;
    partners?: import('../src/demo/partners-demo.js').PartnersDemo;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{
  app: INestApplication;
  url: string;
  logs: () => string;
  waitForLog: (needle: string) => Promise<void>;
}> {
  const chunks: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  const env: NodeJS.ProcessEnv = {
    ...testEnv,
    SUPPORT_WEB_ORIGIN: ORIGIN,
    ...opts.env,
  };
  // 預設用假的 LLM：測試不能真的啟動 CLI
  const app = await createApp(env, {
    logStream,
    llm: opts.llm ?? new FakeLlm(),
    // 預設用假的商店：測試不用開整套商店
    shop: opts.shop ?? fakeShop,
    // 預設用假的商店登入：loginCustomer() 發 sid
    sessions: opts.sessions ?? fakeSessions,
    partners: opts.partners ?? fakePartners,
  });
  await app.listen(0, '127.0.0.1');
  env.MCP_URL = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/mcp`; // 假的 LLM 和真的 CLI 一樣打這裡
  const logs = () => chunks.join('');
  // 請求的 log 在回應送出後才寫
  const waitForLog = async (needle: string) => {
    for (let i = 0; i < 50 && !logs().includes(needle); i++)
      await new Promise((r) => setTimeout(r, 20));
    if (!logs().includes(needle)) {
      const requests = logs()
        .split('\n')
        .filter((l) => l.includes('request completed'));
      throw new Error(
        `log 裡等不到 ${needle}；請求 log：${requests.map((l) => l.replace(/.*"req":/, '')).join(' ¦ ')}`,
      );
    }
  };
  return { app, url: await app.getUrl(), logs, waitForLog };
}

/** 像瀏覽器一樣記住 cookie，預設帶同網域的 Origin */
export class Client {
  readonly cookies = new Map<string, string>();

  constructor(private readonly base: string) {}

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: this.cookieHeader,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const text = await res.text();
    return {
      status: res.status,
      body: text ? JSON.parse(text) : null,
      setCookie: res.headers.getSetCookie(),
    };
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body: unknown = {}, headers?: Record<string, string>) =>
    this.request('POST', path, body, headers);
}
