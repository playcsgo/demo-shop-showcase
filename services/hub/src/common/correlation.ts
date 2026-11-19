import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 目前這段處理屬於哪一筆流程（correlation_id）：HTTP 請求、SQS 指令進來時設定，呼叫外部廠商時帶出去。
 * 廠商（partners）收到後用它記 log，sandbox 也用它決定要不要注入故障（seed＋correlation_id → 每次結果一樣）。
 */
export const correlation = new AsyncLocalStorage<string>();
export const currentCorrelationId = (): string | undefined => correlation.getStore();
