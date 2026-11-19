import { createHash } from 'node:crypto';
import { record } from './events.js';

/**
 * 這一輪測試的設定（sandbox 每個情境開始時用 PUT /admin/run 設定）
 *   seed：空字串 → 每次真的隨機（Math.random，日常手動測試用）
 *         有值   → 「seed＋correlation_id」決定結果：同一個 seed 重跑，同一筆遇到同樣的故障（可以重現）
 *   timeScale：時間壓縮倍數。partners 裡「設定出來的時間」全部同比例縮：API 回應延遲、不回應、callback 晚到、
 *              物流每一站、醫院保留時間、webhook 重送間隔。hub、core、SQS 也用同一個倍數，彼此的大小關係不變
 */
export const run = {
  seed: process.env.SEED ?? '',
  timeScale: Number(process.env.TIME_SCALE ?? 1) || 1,
};

/** 設定出來的時間 ÷ 壓縮倍數 */
export const scaled = (ms: number): number => Math.round(ms / run.timeScale);

// 同一筆流程、同一個動作可能被呼叫好幾次（呼叫端重試）：用次數區分，第 2 次重試不會跟第 1 次擲出一樣的結果
const counters = new Map<string, number>();
export const resetDice = (): void => counters.clear();

/**
 * 一顆骰子＝一個請求（某一筆流程的某一個動作）。
 * 例：dice('s42-u17-i3-checkout', 'mockpay.charge').hit('error', 0.3)
 *   → hash(seed | correlation_id | 動作 | 決定 | 第幾次) 換成 0～1，小於 0.3 就注入
 */
export class Dice {
  constructor(readonly correlationId: string, readonly op: string) {}

  /** 0～1 的值；沒有 seed 就真的隨機 */
  value(decision: string): number {
    if (!run.seed || !this.correlationId) return Math.random();
    const key = `${this.correlationId}|${this.op}|${decision}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    if (counters.size > 200_000) counters.clear(); // 長時間壓力測試不讓它一直長大
    const h = createHash('sha256').update(`${run.seed}|${key}|${n}`).digest();
    return h.readUInt32BE(0) / 0x1_0000_0000;
  }

  /** 要不要注入這個故障；注入了就記一筆（CI 報告「在什麼情況下 fail」就是從這裡來的） */
  hit(decision: string, rate: number): boolean {
    if (rate <= 0) return false;
    const v = this.value(decision);
    if (v >= rate) return false;
    this.injected(decision, { rate, roll: Number(v.toFixed(4)) });
    return true;
  }

  injected(decision: string, extra: Record<string, unknown> = {}): void {
    const [partner] = this.op.split('.');
    record(partner, 'fault.injected', `${this.op} ${decision}`, { correlation_id: this.correlationId || undefined, op: this.op, decision, seed: run.seed || undefined, ...extra });
  }
}

export const dice = (correlationId: string | undefined, op: string): Dice => new Dice(correlationId ?? '', op);
