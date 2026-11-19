import type { DemoSettings, PartnersDemo } from '../src/demo/partners-demo.js';
import { fakeShop } from './fake-shop.js';

// 測試用的 partners 開關（AIC-017）：改的是假商店的物流行為，和真的 partners 一樣
export class FakePartners implements PartnersDemo {
  async settings(): Promise<DemoSettings> {
    return {
      support_demo: fakeShop.slowLogistics ? 'on' : 'off',
      logistics_down: fakeShop.logisticsDown ? 'on' : 'off',
    };
  }
  async update(changes: Partial<DemoSettings>) {
    if (changes.support_demo) fakeShop.slowLogistics = changes.support_demo === 'on';
    if (changes.logistics_down) fakeShop.logisticsDown = changes.logistics_down === 'on';
    return this.settings();
  }
}
export const fakePartners = new FakePartners();
