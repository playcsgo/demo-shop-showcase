// 推測值：跑之前就該知道「低流量時大概多快」，實測偏離太多就是要查的地方
//
// query、pay_api：不經過廠商，兩個世界應該一樣 → 用先前低流量的實測當先驗值（來源寫在 PRIORS）
// pay_e2e（下單 → 付款完成，只算直送／寄倉）：照實際路徑，用「這一輪實際套用的廠商設定」模擬出分布
//   core 交易 commit → outbox relay 撈到（閒置時每 relay_idle_ms 撈一次）→ SQS → hub-payment 呼叫金流
//   → 金流回應（latencyMs ＋ latencyJitterMs × u³）→ 再等 callbackDelayMs 才打 webhook → hub → SQS → core-worker 改成 PAID
// 金流的 errorRate（< 1%）只影響 p99 之後的尾巴，這裡不模擬，算法說明裡會寫出來

export const PRIORS = {
  query: { p50: 10, p95: 40, p99: 80, basis: 'GET /catalog 先前低流量實測的量級（sandbox，p50 約 9～12 ms）' },
  pay_api: { p50: 20, p95: 30, p99: 60, basis: 'POST /checkout 先前低流量實測（sandbox-runs/20261013-130759：結帳 p95 18～22 ms）' },
};

// 跟廠商無關的固定成本
export const PIPELINE = {
  relayIdleMs: 200,   // services/core-api/config/messaging.php relay.idle_sleep_ms：最壞多等一輪
  internalMs: 30,     // core 寫入＋hub＋core-worker 處理（sandbox perfect 量到 hub 內部 p99 44 ms，取平均的量級）
};

/** 可重現的亂數（同樣的設定，推測值每次一樣） */
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

/** 依金流設定模擬 pay_e2e 的分布 */
export function predictPayE2e(payment, { samples = 100_000, pipeline = PIPELINE } = {}) {
  const L = payment?.latencyMs ?? 0;
  const J = payment?.latencyJitterMs ?? 0;
  const C = payment?.callbackDelayMs ?? 0;
  const r = rng();
  const xs = new Float64Array(samples);
  for (let i = 0; i < samples; i++) xs[i] = r() * pipeline.relayIdleMs + L + J * r() ** 3 + C + pipeline.internalMs;
  xs.sort();
  const basis = [
    `relay 等待 0～${pipeline.relayIdleMs}`,
    `金流 ${L}${J ? `＋${J}×u³` : ''}`,
    `callback 延遲 ${C}`,
    `內部處理 ${pipeline.internalMs}`,
  ].join(' ＋ ') + ' ms' + (payment?.errorRate ? `（金流錯誤 ${(payment.errorRate * 100).toFixed(1)}% 會重試，只影響 p99 之後）` : '');
  return { p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), p99: quantile(xs, 0.99), basis };
}

/** 一個世界的三個推測值 */
export function predictWorld(partnerSettings) {
  return {
    query: { ...PRIORS.query, basis: `${PRIORS.query.basis}；不經過廠商，兩個世界應該一樣` },
    pay_api: { ...PRIORS.pay_api, basis: `${PRIORS.pay_api.basis}；結帳不等廠商（付款走 outbox），兩個世界應該一樣` },
    pay_e2e: predictPayE2e(partnerSettings?.payment),
  };
}
