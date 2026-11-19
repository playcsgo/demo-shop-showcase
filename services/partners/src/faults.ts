import { type Dice, scaled } from './dice.js';

// 故障注入：每個外部廠商各自一組設定，控制台可以即時調整
export type Mode = 'normal' | 'down' | 'hang';

export interface FaultSettings {
  mode: Mode;          // down：直接回 503；hang：不回應（讓呼叫端逾時）
  latencyMs: number;   // 每個請求固定的延遲
  latencyJitterMs: number; // 再加上 0～這麼多的隨機延遲（大多很小、偶爾很大：模擬真實 API 的長尾）
  errorRate: number;   // 0～1：回 500 的機率
}

export interface Settings {
  payment: FaultSettings & {
    declineRate: number;        // 付款被拒（charge.failed）
    duplicateRate: number;      // 0～1：同一個 webhook 多送一次的機率
    dropCallbackRate: number;   // 付款成功但 webhook 沒送（靠對帳補）
    callbackDelayMs: number;
  };
  logistics: FaultSettings & {
    duplicateRate: number;
    outOfOrderRate: number;     // 物流狀態亂序送達
    stepDelayMs: number;        // 已收件 → 配送中 → 送達 每一步的間隔
    statusCallbacks: 'on' | 'off'; // off：只收單、回追蹤號碼，不回傳狀態（壓測用：量到「交給物流」為止；狀態回呼會佔住 core 的回程佇列）
    slowClasses: string[];      // 大型物流 demo（AIC-017）：這些運送類別整段要 slowTotalMs，預設空的＝和以前一樣
    slowTotalMs: number;
  };
  clinic: FaultSettings & {
    fullRate: number;           // 額滿：保留時段時被拒（回 409）
    holdTtlSeconds: number;     // 保留有效時間（醫院的規則；過期自動釋放）
    confirmLostRate: number;    // 確認成功了，但回應在路上遺失（回 504）
  };
  line: FaultSettings;
}

const base = (): FaultSettings => ({ mode: 'normal', latencyMs: 0, latencyJitterMs: 0, errorRate: 0 });

export const defaults = (): Settings => ({
  payment: { ...base(), declineRate: 0, duplicateRate: 0, dropCallbackRate: 0, callbackDelayMs: 500 },
  logistics: { ...base(), duplicateRate: 0, outOfOrderRate: 0, stepDelayMs: 1500, statusCallbacks: 'on', slowClasses: [], slowTotalMs: 20 * 60_000 },
  clinic: { ...base(), fullRate: 0, holdTtlSeconds: 600, confirmLostRate: 0 },
  line: base(),
});

export let settings: Settings = defaults();

export function updateSettings(patch: Partial<Record<keyof Settings, Record<string, unknown>>>): Settings {
  for (const [partner, values] of Object.entries(patch)) {
    const target = settings[partner as keyof Settings] as unknown as Record<string, unknown>;
    if (!target || !values) continue;
    for (const [k, v] of Object.entries(values)) {
      if (!(k in target)) continue;
      if (Array.isArray(target[k])) {
        if (Array.isArray(v)) target[k] = v.filter((x) => typeof x === 'string'); // 清單只收清單
      } else target[k] = typeof target[k] === 'number' ? Number(v) : v;
    }
  }
  return settings;
}

export function resetSettings(): Settings {
  settings = defaults();
  return settings;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 依設定決定這個請求要不要故障；回傳 null 代表正常處理。
 * 機率由 dice 決定（有 seed 時同一筆每次結果一樣，見 dice.ts）。
 * 回應延遲、「不回應」也跟著時間壓縮：呼叫端（hub）的逾時同比例縮，兩邊的大小關係不變。
 */
export async function applyFaults(f: FaultSettings, d: Dice): Promise<{ status: number; body: unknown } | null> {
  if (f.mode === 'down') { d.injected('down'); return { status: 503, body: { error: 'service_unavailable' } }; }
  if (f.mode === 'hang') {
    d.injected('hang');
    await sleep(scaled(60_000)); // 呼叫端應該在這之前逾時
    return { status: 504, body: { error: 'timeout' } };
  }
  const delay = f.latencyMs + (f.latencyJitterMs > 0 ? f.latencyJitterMs * d.value('latency') ** 3 : 0);
  if (delay > 0) await sleep(scaled(delay));
  if (d.hit('error', f.errorRate)) return { status: 500, body: { error: 'internal_error' } };
  return null;
}
