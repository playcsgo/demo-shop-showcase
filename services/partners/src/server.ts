import Fastify, { type FastifyBaseLogger } from 'fastify';
import { readFileSync } from 'node:fs';
import { clearLog, logger, recent, stats } from './events.js';
import { resetDice, run } from './dice.js';
import { resetSettings, settings, updateSettings } from './faults.js';
import { registerPartners, resetPartnersState, seedCharge } from './partners.js';
import { presets } from './presets.js';

// partners：模擬外部廠商（金流、物流、寵物醫院、LINE）＋ 故障注入控制台
// 每個請求的 log 由 record() 以業務事件的形式寫（控制台每秒輪詢 /admin/state，逐筆記請求會太吵）
const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger, disableRequestLogging: true });

registerPartners(app);

// ───────── 控制台 ─────────
const panel = readFileSync(new URL('./panel.html', import.meta.url), 'utf8');
app.get('/', async (_req, reply) => reply.type('text/html').send(panel));
app.get('/admin/state', async () => ({
  run,
  settings,
  stats,
  events: recent(),
  presets: Object.fromEntries(Object.entries(presets).map(([k, v]) => [k, v.label])),
}));
app.put<{ Body: Parameters<typeof updateSettings>[0] }>('/admin/settings', async (req) => updateSettings(req.body));
app.post<{ Params: { name: string } }>('/admin/presets/:name', async (req, reply) => {
  const preset = presets[req.params.name];
  if (!preset) return reply.code(404).send({ error: 'unknown_preset' });
  preset.apply();
  return settings;
});
app.post('/admin/clear-log', async () => { clearLog(); return { ok: true }; });
// demo 用：登記已付款的扣款（AIC-016）。只有 /admin，和 /admin/reset 一樣不對外
app.post<{ Body: { charge_id?: unknown; order_no?: unknown; amount?: unknown } }>('/admin/charges', async (req, reply) => {
  const { charge_id, order_no, amount } = req.body ?? {};
  if (typeof charge_id !== 'string' || typeof order_no !== 'string' || !Number.isInteger(amount) || (amount as number) <= 0)
    return reply.code(422).send({ error: 'invalid_charge' });
  return seedCharge({ charge_id, order_no, amount: amount as number });
});
// sandbox：這一輪的 seed、時間壓縮倍數（見 dice.ts）
app.put<{ Body: { seed?: string; timeScale?: number } }>('/admin/run', async (req) => {
  if (req.body.seed !== undefined) run.seed = String(req.body.seed);
  if (req.body.timeScale !== undefined) run.timeScale = Number(req.body.timeScale) || 1;
  return run;
});
// sandbox：每個情境開始前回到乾淨狀態（設定、付款、保留、事件紀錄、擲骰次數全部清掉），不用重啟容器
app.post('/admin/reset', async () => {
  resetSettings(); resetPartnersState(); resetDice(); clearLog();
  run.seed = process.env.SEED ?? ''; run.timeScale = Number(process.env.TIME_SCALE ?? 1) || 1;
  return { ok: true };
});
app.get('/health', async () => ({ ok: true }));

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4000) });
