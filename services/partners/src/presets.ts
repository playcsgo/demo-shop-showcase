import { resetSettings, updateSettings } from './faults.js';

// 控制台的一鍵情境（demo 錄影、sandbox 情境都用）
export const presets: Record<string, { label: string; apply: () => void }> = {
  // 完美世界：所有延遲都是 0（金流回呼、物流每一步也是 0）→ 量到的只有我們自己的服務
  perfect: {
    label: '完美世界：沒有延遲、沒有錯誤',
    apply: () => {
      resetSettings();
      updateSettings({ payment: { callbackDelayMs: 0 }, logistics: { stepDelayMs: 0 } });
    },
  },
  // 真實世界：API 回應有長尾（大多幾百毫秒、偶爾一兩秒）、少量錯誤、偶爾重複或亂序；數值是常見第三方 API 的量級，不是哪一家的實測
  realistic: {
    label: '真實世界：延遲有長尾、0.5% 錯誤、偶爾重複 callback／亂序、醫院 5% 額滿',
    apply: () => {
      resetSettings();
      updateSettings({
        payment: { latencyMs: 150, latencyJitterMs: 1200, errorRate: 0.005, declineRate: 0.02, duplicateRate: 0.01, dropCallbackRate: 0.002, callbackDelayMs: 800 },
        logistics: { latencyMs: 100, latencyJitterMs: 400, errorRate: 0.005, duplicateRate: 0.02, outOfOrderRate: 0.02, stepDelayMs: 15000 },
        clinic: { latencyMs: 200, latencyJitterMs: 600, errorRate: 0.005, fullRate: 0.05, confirmLostRate: 0.005 },
        line: { latencyMs: 50, latencyJitterMs: 200, errorRate: 0.01 },
      });
    },
  },
  chaos: {
    label: '完全隨機：金流 30% 錯誤＋20% 重複 callback＋5% 不回、物流 20% 亂序、醫院 30% 額滿＋確認 20% 回應遺失',
    apply: () => {
      resetSettings();
      updateSettings({
        payment: { errorRate: 0.3, duplicateRate: 0.2, dropCallbackRate: 0.05 },
        logistics: { duplicateRate: 0.2, outOfOrderRate: 0.2, stepDelayMs: 800 },
        clinic: { fullRate: 0.3, confirmLostRate: 0.2 },
      });
    },
  },
  paymentDown: { label: '金流掛掉（503）', apply: () => updateSettings({ payment: { mode: 'down' } }) },
  paymentHang: { label: '金流不回應（逾時）', apply: () => updateSettings({ payment: { mode: 'hang' } }) },
  paymentSlow: { label: '金流很慢（3 秒）', apply: () => updateSettings({ payment: { latencyMs: 3000 } }) },
  clinicFull: { label: '醫院全部額滿', apply: () => updateSettings({ clinic: { fullRate: 1 } }) },
  holdShort: { label: '保留只有 30 秒（付款太慢 → 時段過期）', apply: () => updateSettings({ clinic: { holdTtlSeconds: 30 } }) },
};
