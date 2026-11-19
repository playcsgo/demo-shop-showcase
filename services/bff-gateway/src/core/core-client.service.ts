import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface CoreResponse<T = any> { status: number; data: T }

/**
 * 呼叫 core-api 的唯一入口：逾時、帶 JWT、帶 correlation id、統一錯誤格式。
 * BFF 是「防腐層」：core 的網址或格式改了，只要改這裡和對應的 controller，前台不用動。
 */
@Injectable()
export class CoreClient {
  private readonly logger = new Logger(CoreClient.name);
  private readonly base: string;

  constructor(config: ConfigService) {
    this.base = config.get<string>('CORE_URL') ?? 'http://core-nginx';
  }

  async call<T = any>(path: string, opts: {
    method?: string; token?: string; body?: unknown; headers?: Record<string, string>; correlationId?: string; timeoutMs?: number;
  } = {}): Promise<CoreResponse<T>> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/v1${path}`, {
        method: opts.method ?? 'GET',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.correlationId ? { 'x-correlation-id': opts.correlationId } : {}),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
    } catch (e) {
      this.logger.warn({ path, err: (e as Error).message }, `core ${path} unreachable`);
      throw new HttpException({ error: 'core_unavailable' }, 503);
    }
    const data = (await res.json().catch(() => ({}))) as T;
    this.logger.debug({ method: opts.method ?? 'GET', path, status: res.status, ms: Date.now() - started }, `core ${opts.method ?? 'GET'} ${path} → ${res.status}`);
    return { status: res.status, data };
  }

  /** 把 core 的結果原封不動回給前台（包含錯誤狀態碼與 {error, message}） */
  static unwrap<T>(r: CoreResponse<T>): T {
    if (r.status >= 400) throw new HttpException(r.data as object, r.status);
    return r.data;
  }
}
