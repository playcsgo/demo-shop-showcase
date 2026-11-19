import { scaled } from './dice.js';
import { settings } from './faults.js';

// 物流的時程（AIC-017）：已收件 → 配送中 → 送達，每一段的間隔。
// 「大型物流 demo」打開時，slowClasses 裡的運送類別整段要 slowTotalMs（預設 20 分鐘），其他照 stepDelayMs

/** 每一段的間隔（還沒壓縮時間）；沒帶運送類別的舊訊息照一般速度 */
export function stepMsFor(shippingClass: string | undefined): number {
  const l = settings.logistics;
  return shippingClass && l.slowClasses.includes(shippingClass) ? l.slowTotalMs / 3 : l.stepDelayMs;
}

/** 物流商給的預估（像真的物流商提供的預估 API）：和實際的回呼時程用同一個算法 */
export function estimate(shippingClass: string) {
  return {
    shipping_class: shippingClass,
    estimated_seconds: (scaled(stepMsFor(shippingClass)) * 3) / 1000,
    slow: settings.logistics.slowClasses.includes(shippingClass),
  };
}
