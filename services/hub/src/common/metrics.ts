import { createSocket } from 'node:dgram';

/**
 * 自訂指標（DogStatsD）：用 UDP 丟給 Datadog Agent（port 8125），跟 core 的 StatsD.php 一樣。
 * UDP 不等回應、送失敗也不丟例外 → 監控壞掉不會拖垮業務。沒設 DD_AGENT_HOST（沒開 Datadog、跑單元測試）時什麼都不做。
 *
 * 不用 dd-trace 的 tracer.dogstatsd：DD_TRACE_ENABLED=false 時 dd-trace 整個換成空操作，指標也跟著不送；
 * 壓測時要「只送指標、不開 APM」（trace 本身很吃 CPU，會拖慢被測的服務），所以指標自己送。
 * 每個指標都帶 env、service、version（unified service tagging），K8s、sandbox 各套的數字才分得開。
 */
type Tags = Record<string, string | number>;

const host = process.env.DD_AGENT_HOST;
const port = Number(process.env.DD_DOGSTATSD_PORT ?? 8125);
const globalTags: Tags = Object.fromEntries(
  [['env', process.env.DD_ENV], ['service', process.env.DD_SERVICE], ['version', process.env.DD_VERSION]].filter(([, v]) => v),
);
const socket = host ? createSocket('udp4') : null;
socket?.on('error', () => {}); // 送不出去就算了
socket?.unref();                // 不要因為這個 socket 讓程序結束不了

function send(metric: string, value: number, type: string, tags: Tags = {}): void {
  if (!socket || !host) return;
  const all = Object.entries({ ...globalTags, ...tags }).map(([k, v]) => `${k}:${v}`).join(',');
  socket.send(`${metric}:${value}|${type}${all ? `|#${all}` : ''}`, port, host);
}

export const metrics = {
  increment: (metric: string, value = 1, tags?: Tags) => send(metric, value, 'c', tags),
  gauge: (metric: string, value: number, tags?: Tags) => send(metric, value, 'g', tags),
  /** distribution：每一筆數值都送給 Datadog，由 Datadog 算 p50／p90／p99 */
  distribution: (metric: string, value: number, tags?: Tags) => send(metric, value, 'd', tags),
};

/**
 * 這個服務「收到 → 做完」花了幾毫秒（跟 core 的 PipelineMetrics 同一個指標，step 標籤區分是誰做什麼）
 * 量的是 hub 自己的處理時間：程式本身＋它呼叫廠商、Redis、送 SQS 的時間；不含在佇列裡排隊的時間
 */
export const handled = (step: string, startedMs: number) =>
  metrics.distribution('demo.pipeline.handle_ms', Date.now() - startedMs, { step });

/** 整筆訂單：客人按下結帳（nginx 收到）→ hub 把出貨交給物流，花了幾毫秒 */
export const orderLifecycle = (requestedAtMs: number) =>
  metrics.distribution('demo.order.lifecycle_ms', Date.now() - requestedAtMs);
