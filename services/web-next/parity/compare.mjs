#!/usr/bin/env node
// NestJS 版和 Next.js 版的 BFF 對照（spec AC-1～AC-3）：同一組請求各打一次，比較狀態碼、回應內容和 cookie 的屬性
//
//   node services/web-next/parity/compare.mjs --nest http://bff-gateway:3000 --next http://web-next:3000
//
// - 兩邊要連同一個 core 和同一個 Redis（登入狀態互通才比得出來）
// - 兩邊用不同的測試帳號（shopper01、shopper02），各自從空購物車開始
// - 必然不同的值先換成記號再比：單號、自動編號的 id、時間、耗時、帳號
import { isDeepStrictEqual, parseArgs } from 'node:util';

const { values: o } = parseArgs({ options: {
  nest: { type: 'string', default: 'http://bff-gateway:3000' },
  next: { type: 'string', default: 'http://web-next:3000' },
  supportKey: { type: 'string', default: process.env.SUPPORT_SERVICE_KEY ?? 'local-support-service-key' },
  password: { type: 'string', default: '0204' },
} });

const sides = {
  nest: { base: o.nest, email: 'shopper01@example.test', sid: null },
  next: { base: o.next, email: 'shopper02@example.test', sid: null },
};
const other = (s) => (s === 'nest' ? 'next' : 'nest');

// Set-Cookie 拆成屬性再比（屬性的順序、Expires 的時間不重要）
function parseSetCookie(raw) {
  if (!raw) return null;
  const [pair, ...attrs] = raw.split(';').map((x) => x.trim());
  const eq = pair.indexOf('=');
  const out = { name: pair.slice(0, eq), hasValue: pair.length > eq + 1, value: pair.slice(eq + 1) };
  for (const a of attrs) {
    const [k, v] = a.split('=');
    out[k.toLowerCase()] = k.toLowerCase() === 'expires' ? (new Date(v).getTime() < Date.now() ? '<past>' : '<future>') : (v ?? true);
  }
  return out;
}

async function call(side, method, path, { body, sid, headers = {}, raw } = {}) {
  const s = sides[side];
  const cookie = sid === undefined ? s.sid : sid;
  const res = await fetch(`${s.base}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie: `sid=${cookie}` } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  const setCookie = parseSetCookie(res.headers.get('set-cookie'));
  return {
    status: res.status, body: json, cookie: setCookie,
    correlation: res.headers.get('x-correlation-id'),
    leaksJwt: /eyJ[A-Za-z0-9_-]{10,}\./.test(text + JSON.stringify([...res.headers])),   // AC-3：回應裡不能有 JWT
  };
}

function normalize(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => normalize(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, k)]));
  if (typeof v === 'string' && /^A\d{6}[A-Z0-9]{7}$/.test(v)) return '<order_no>';
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d/.test(v)) return '<time>';
  if (['id', 'payment_id', 'order_id', 'customer_id', 'shipment_id', 'cart_item_id'].includes(key) && v !== null) return '<id>';
  if (key === 'email' && typeof v === 'string' && v.startsWith('shopper')) return '<email>';
  if (key === 'name' && typeof v === 'string' && /^shopper/i.test(v)) return '<name>';
  if (key === 'took_ms') return '<ms>';
  if (key === 'value') return '<cookie-value>';
  if (key === 'correlation') return typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? '<uuid>' : v;
  if (['correlation_id', 'idempotency_key', 'payment_token_ref'].includes(key)) return `<${key}>`;
  if (typeof v === 'string') return v.replace(/A\d{6}[A-Z0-9]{7}/g, '<order_no>');   // 「Cannot GET /api/orders/A…」這類訊息裡的單號
  return v;
}

const results = [];
const known = [];
function compare(name, a, b, knownDiff) {
  const na = normalize(a), nb = normalize(b);
  const ok = isDeepStrictEqual(na, nb);
  if (knownDiff) {
    // 已知差異：確認它「還是不一樣」，哪天變一致了要把這條拿掉
    known.push({ name, why: knownDiff, stillDifferent: !ok });
    console.log(`${ok ? '❌ 已知差異變一致了，該拿掉：' : '⚠️  已知差異：'}${name}（${knownDiff}）`);
    if (ok) results.push({ name, ok: false });
    return;
  }
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) {
    console.log('   Nest:', JSON.stringify(na).slice(0, 1200));
    console.log('   Next:', JSON.stringify(nb).slice(0, 1200));
  }
}
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `  ${detail}`}`);
}
async function both(name, fn, knownDiff) {
  const [a, b] = [await fn('nest'), await fn('next')];
  compare(name, a, b, knownDiff);
  return { nest: a, next: b };
}
const login = (side, password = o.password) => call(side, 'POST', '/api/auth/login', { body: { email: sides[side].email, password }, sid: null });

// ── 沒登入 ──
const catalog = await both('商品目錄（不用登入）', (s) => call(s, 'GET', '/api/catalog'));
await both('沒登入：/api/me → 401', (s) => call(s, 'GET', '/api/me'));
await both('沒登入：/api/cart → 401', (s) => call(s, 'GET', '/api/cart'));
await both('亂寫的 sid → 401', (s) => call(s, 'GET', '/api/cart', { sid: 'not-a-real-session' }));
await both('沒登入：結帳 → 401（先檢查登入，再檢查 Idempotency-Key）', (s) => call(s, 'POST', '/api/checkout', { body: {} }));
await both('/api 底下不存在的路徑 → 404', (s) => call(s, 'GET', '/api/nope/x'));
await both('方法不對（GET /api/auth/login）', (s) => call(s, 'GET', '/api/auth/login'), 'NestJS 回 404，Next.js 回 405；前台不會這樣呼叫');
await both('追蹤號碼：帶了就沿用', (s) => call(s, 'GET', '/api/me', { headers: { 'x-correlation-id': 'parity-corr-1' } }));
await both('追蹤號碼：超過 64 字只取前 64', (s) => call(s, 'GET', '/api/me', { headers: { 'x-correlation-id': 'p'.repeat(80) } }));

// ── 登入 ──
await both('登入：JSON 壞掉 → 400（狀態碼和格式）', (s) => call(s, 'POST', '/api/auth/login', { raw: '{"email": ', sid: null }).then((r) => ({ status: r.status, body: { ...r.body, message: '<parser message>' } })));
await both('登入：JSON 壞掉時回應有沒有追蹤號碼', (s) => call(s, 'POST', '/api/auth/login', { raw: '{"email": ', sid: null }).then((r) => ({ hasCorrelation: Boolean(r.correlation) })), 'NestJS 在解析 body 時就失敗，還沒產生追蹤號碼；Next.js 有');
await both('登入：沒有 body', (s) => call(s, 'POST', '/api/auth/login', { sid: null }));
await both('登入：email 格式錯、沒給密碼 → 422', (s) => call(s, 'POST', '/api/auth/login', { body: { email: 'bad' }, sid: null }));
await both('登入：密碼錯 → 401', (s) => login(s, 'wrong'));
const ok = await both('登入成功：只回名字和 email，cookie 是 HttpOnly、SameSite=Lax、Path=/、7 天', (s) => login(s));
for (const s of ['nest', 'next']) sides[s].sid = ok[s].cookie?.value;
check('AC-3：登入的回應裡沒有 JWT', !ok.nest.leaksJwt && !ok.next.leaksJwt);
check('AC-3：登入回應只有 name、email 兩個欄位', ['nest', 'next'].every((s) => isDeepStrictEqual(Object.keys(ok[s].body).sort(), ['email', 'name'])));
await both('/api/me', (s) => call(s, 'GET', '/api/me'));

// ── AC-2：兩個版本的登入狀態互通 ──
await both('AC-2：用另一個版本建立的 session 也能用（/api/me）', (s) => call(s, 'GET', '/api/me', { sid: sides[other(s)].sid }).then((r) => ({ status: r.status, hasName: typeof r.body.name === 'string' })));
await both('AC-2：用另一個版本建立的 session 讀購物車', (s) => call(s, 'GET', '/api/cart', { sid: sides[other(s)].sid }).then((r) => ({ status: r.status })));

// ── 購物車 ──
for (const s of ['nest', 'next']) {
  const cart = await call(s, 'GET', '/api/cart');
  for (const it of cart.body.items ?? []) await call(s, 'DELETE', `/api/cart/items/${it.id}`);
}
// 兩個一般的常溫品項（目錄兩邊相同，前面比過了）。不用狗屋：庫存只有 3 件，一邊買完另一邊就缺貨
const bySku = Object.fromEntries(catalog.nest.body.data.flatMap((p) => p.variants ?? []).map((v) => [v.sku, v]));
const [v1, v2] = [bySku['DCS-FD-CHK-80'], bySku['DCS-CAN-DUCK-80']];
check('目錄裡找得到測試用的兩個品項', Boolean(v1?.in_stock && v2?.in_stock));

await both('空購物車', (s) => call(s, 'GET', '/api/cart'));
await both('放商品：欄位都沒給 → 422（core 的錯誤原樣回來）', (s) => call(s, 'PUT', '/api/cart/items', { body: {} }));
await both('放商品：沒有 body', (s) => call(s, 'PUT', '/api/cart/items'));
await both('放商品：商品不存在 → 422', (s) => call(s, 'PUT', '/api/cart/items', { body: { variant_id: 999999, fulfillment_type: 'direct', qty: 1 } }));
await both('放商品：第一件 ×2', (s) => call(s, 'PUT', '/api/cart/items', { body: { variant_id: v1.id, fulfillment_type: 'direct', qty: 2 } }));
await both('放商品：第二件 ×1', (s) => call(s, 'PUT', '/api/cart/items', { body: { variant_id: v2.id, fulfillment_type: 'direct', qty: 1 } }));
await both('放商品：第一件改成 ×3', (s) => call(s, 'PUT', '/api/cart/items', { body: { variant_id: v1.id, fulfillment_type: 'direct', qty: 3 } }));
await both('購物車有兩件', (s) => call(s, 'GET', '/api/cart'));
await both('刪除：id 不是數字', (s) => call(s, 'DELETE', '/api/cart/items/abc'));
await both('刪除：不是自己的品項', (s) => call(s, 'DELETE', '/api/cart/items/99999999'));
await both('刪掉第二件', async (s) => {
  const cart = await call(s, 'GET', '/api/cart');
  return call(s, 'DELETE', `/api/cart/items/${cart.body.items.find((i) => i.variant_id === v2.id).id}`);
});

// ── 結帳 ──
// 兩個帳號原本的訂單數可能不同（之前跑過幾次）：比「多了幾張」，不比總數
const ordersBefore = {};
for (const s of ['nest', 'next']) ordersBefore[s] = (await call(s, 'GET', '/api/orders')).body.data.length;
await both('結帳：沒帶 Idempotency-Key → 400', (s) => call(s, 'POST', '/api/checkout', { body: {} }));
await both('結帳：utm_source 太長 → 422', (s) => call(s, 'POST', '/api/checkout', { body: { utm_source: 'x'.repeat(51) }, headers: { 'idempotency-key': `parity-long-${Date.now()}-${s}` } }));
const key = { nest: `parity-${Date.now()}-nest`, next: `parity-${Date.now()}-next` };
const placed = await both('結帳成功 → 201', (s) => call(s, 'POST', '/api/checkout', { body: { utm_source: 'parity' }, headers: { 'idempotency-key': key[s] } }));
await both('同一個 key 重送 → 同一張訂單，狀態碼照 core 回的', async (s) => {
  const r = await call(s, 'POST', '/api/checkout', { body: { utm_source: 'parity' }, headers: { 'idempotency-key': key[s] } });
  return { ...r, sameOrder: r.body.order_no === placed[s].body.order_no };
});
await both('同一個 key、內容不同 → 422', (s) => call(s, 'POST', '/api/checkout', { body: { utm_source: 'other' }, headers: { 'idempotency-key': key[s] } }));
await both('結帳後購物車是空的', (s) => call(s, 'GET', '/api/cart'));
await both('結帳：空購物車 → 422', (s) => call(s, 'POST', '/api/checkout', { body: {}, headers: { 'idempotency-key': `parity-empty-${Date.now()}-${s}` } }));

// ── 訂單、寄倉、訂閱、總覽 ──
const orderNo = { nest: placed.nest.body.order_no, next: placed.next.body.order_no };
await both('訂單列表（多了 1 張，第一筆的欄位）', (s) => call(s, 'GET', '/api/orders').then((r) => ({ status: r.status, added: r.body.data?.length - ordersBefore[s], first: r.body.data?.[0] && Object.keys(r.body.data[0]).sort() })));
await both('訂單詳情（欄位和金額）', (s) => call(s, 'GET', `/api/orders/${orderNo[s]}`).then((r) => ({ status: r.status, keys: Object.keys(r.body.data ?? r.body).sort(), total: (r.body.data ?? r.body).total_amount ?? (r.body.data ?? r.body).total })));
await both('別人的訂單 → 404（core 判斷，BFF 原樣回）', (s) => call(s, 'GET', `/api/orders/${orderNo[other(s)]}`));
await both('不存在的訂單 → 404', (s) => call(s, 'GET', '/api/orders/NOPE'));
await both('訂單編號有特殊字元', (s) => call(s, 'GET', '/api/orders/a%2Fb%20c'));
await both('寄倉', (s) => call(s, 'GET', '/api/warehouse'));
await both('寄倉提領：沒帶 Idempotency-Key → 400', (s) => call(s, 'POST', '/api/warehouse/withdrawals', { body: {} }));
await both('寄倉提領：內容不對（core 的錯誤原樣回來）', (s) => call(s, 'POST', '/api/warehouse/withdrawals', { body: {}, headers: { 'idempotency-key': `parity-w-${Date.now()}-${s}` } }));
await both('訂閱', (s) => call(s, 'GET', '/api/subscriptions'));
await both('會員總覽（四塊都有、訂單最多 5 筆）', (s) => call(s, 'GET', '/api/me/overview').then((r) => ({
  status: r.status, keys: Object.keys(r.body).sort(), customer: r.body.customer,
  sections: Object.fromEntries(['recent_orders', 'warehouse', 'subscriptions', 'cart_count'].map((k) => [k, r.body[k]?.ok])),
  ordersAsExpected: r.body.recent_orders?.data?.length === Math.min(5, ordersBefore[s] + 1), cart: r.body.cart_count?.data, tookIsNumber: typeof r.body.took_ms === 'number',
})));
await both('沒登入：會員總覽 → 401', (s) => call(s, 'GET', '/api/me/overview', { sid: null }));

// ── 行為事件 ──
await both('事件：兩則允許的、一則不允許的 → 收 2 則', (s) => call(s, 'POST', '/api/events', { body: { events: [{ name: 'page_view' }, { name: 'drop_table' }, { name: 'add_to_cart', sku: 'X' }] } }));
await both('事件：都不允許 → 收 0 則', (s) => call(s, 'POST', '/api/events', { body: { events: [{ name: 'nope' }] } }));
await both('事件：25 則 → 最多收 10 則', (s) => call(s, 'POST', '/api/events', { body: { events: Array.from({ length: 25 }, () => ({ name: 'page_view' })) } }));
await both('事件：沒登入也收', (s) => call(s, 'POST', '/api/events', { body: { events: [{ name: 'page_view' }] }, sid: null }));
await both('事件：空的物件', (s) => call(s, 'POST', '/api/events', { body: {} }));

// ── AI 客服用的 session 查詢 ──
const resolve = (s, sid, k = o.supportKey) => call(s, 'POST', '/internal/session/resolve', { body: sid === undefined ? {} : { sid }, sid: null, headers: k === null ? {} : { 'x-service-key': k } });
await both('客服查 session：有效的 sid → 只回 id、名字、email', (s) => resolve(s, sides[s].sid));
check('AC-3：客服查 session 的回應裡沒有 JWT', !(await resolve('next', sides.next.sid)).leaksJwt);
await both('客服查 session：另一個版本建立的 sid 也認得', (s) => resolve(s, sides[other(s)].sid).then((r) => ({ status: r.status, valid: r.body.valid })));
await both('客服查 session：亂寫的 sid → valid false', (s) => resolve(s, 'nope'));
await both('客服查 session：沒帶 sid → valid false', (s) => resolve(s, undefined));
await both('客服查 session：sid 超過 100 字 → valid false', (s) => resolve(s, 'x'.repeat(500)));
await both('客服查 session：金鑰錯 → 401', (s) => resolve(s, sides[s].sid, 'wrong'));
await both('客服查 session：沒帶金鑰 → 401', (s) => resolve(s, sides[s].sid, null));

// ── 登出 ──
const sidBefore = { nest: sides.nest.sid, next: sides.next.sid };
await both('登出 → 204，cookie 設成過期', (s) => call(s, 'POST', '/api/auth/logout'));
await both('登出後同一個 sid 不能用 → 401', (s) => call(s, 'GET', '/api/me', { sid: sidBefore[s] }));
await both('登出後客服也查不到 → valid false', (s) => resolve(s, sidBefore[s]));
await both('沒登入就登出 → 204', (s) => call(s, 'POST', '/api/auth/logout', { sid: null }));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}／${results.length} 項一致，另有 ${known.length} 項已知差異${failed.length ? `；不一致：\n  - ${failed.map((r) => r.name).join('\n  - ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
