import { randomUUID } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';

/** 服務之間共用的事件信封（system-design §3.3），和 core 的 Outbox 格式一致 */
export interface Envelope<P = Record<string, unknown>> {
  event_id: string;
  type: string;
  version: number;
  occurred_at: string;
  correlation_id: string;
  causation_id: string | null;
  project_code: string | null;
  payload: P;
}

const NAMESPACE = '6f1c7d2e-2b7a-4d8e-9c1a-5b0f3e7a9d11';

/**
 * 「同一件事」產生「同一個 event_id」：
 * 例如付款成功可能從 webhook 來、也可能從對帳查詢來，兩條路徑算出的 id 相同 → core 的 inbox 自然去重。
 */
export const deterministicId = (key: string) => uuidv5(key, NAMESPACE);

export function envelope<P extends Record<string, unknown>>(
  type: string,
  payload: P,
  opts: { correlationId?: string; causationId?: string | null; eventId?: string; projectCode?: string | null } = {},
): Envelope<P> {
  return {
    event_id: opts.eventId ?? randomUUID(),
    type,
    version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: opts.correlationId ?? randomUUID(),
    causation_id: opts.causationId ?? null,
    project_code: opts.projectCode ?? null,
    payload,
  };
}
