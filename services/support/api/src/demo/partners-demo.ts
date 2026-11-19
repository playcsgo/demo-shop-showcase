// 控制台的 demo 面板改的是 partners（假物流商）的設定（AIC-017）：support 自己不存物流設定。
// 只開放兩個開關，其他設定（壓測用的延遲、故障率）碰不到

export const PARTNERS_DEMO = Symbol('PARTNERS_DEMO');

export type DemoSettings = {
  support_demo: 'on' | 'off'; // 大型物流 demo：貓砂、狗屋整段 20 分鐘
  logistics_down: 'on' | 'off'; // 物流商故障：預估查不到，AI 轉真人
};

export interface PartnersDemo {
  settings(): Promise<DemoSettings>;
  update(changes: Partial<DemoSettings>): Promise<DemoSettings>;
}

const SLOW_CLASSES = ['bulky', 'litter'];

type Logistics = { slowClasses: string[]; mode: string };

/** 呼叫 partners 的 /admin/state、/admin/settings */
export class PartnersAdmin implements PartnersDemo {
  constructor(private readonly url: string) {
    if (!url) throw new Error('缺少 PARTNERS_URL');
  }

  private static view(l: Logistics): DemoSettings {
    return {
      support_demo: l.slowClasses.length ? 'on' : 'off',
      logistics_down: l.mode === 'down' ? 'on' : 'off',
    };
  }

  async settings() {
    const res = await fetch(`${this.url}/admin/state`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`partners ${res.status}`);
    return PartnersAdmin.view(((await res.json()) as { settings: { logistics: Logistics } }).settings.logistics);
  }

  async update(changes: Partial<DemoSettings>) {
    const logistics: Partial<Logistics> = {};
    if (changes.support_demo) logistics.slowClasses = changes.support_demo === 'on' ? SLOW_CLASSES : [];
    if (changes.logistics_down) logistics.mode = changes.logistics_down === 'on' ? 'down' : 'normal';
    const res = await fetch(`${this.url}/admin/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logistics }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`partners ${res.status}`);
    return PartnersAdmin.view(((await res.json()) as { logistics: Logistics }).logistics);
  }
}
