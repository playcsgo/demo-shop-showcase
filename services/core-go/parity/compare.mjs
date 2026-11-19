#!/usr/bin/env node
// PHP 版和 Go 版的結果對照（spec AC-1）：同一組請求各打一次，比較回應和寫進資料庫的內容
//
//   node services/core-go/parity/compare.mjs [--php http://localhost:8088] [--go http://127.0.0.1:18080]
//
// - PHP 走 K8s 的入口（Host: core.localhost）；Go 可以是本機 `core-go api --http`（連叢集的資料庫）或另一個入口
// - 兩邊用不同的測試帳號（shopper19001、shopper19002），各自從空購物車開始
// - 必然不同的值先換成記號再比：token、單號、自動編號的 id、時間
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isDeepStrictEqual } from 'node:util';

const { values: o } = parseArgs({ options: {
  php: { type: 'string', default: 'http://localhost:8088' },
  phpHost: { type: 'string', default: 'core.localhost' },
  go: { type: 'string', default: 'http://127.0.0.1:18080' },
  goHost: { type: 'string', default: '' },
  bffKey: { type: 'string', default: process.env.BFF_SERVICE_KEY ?? '' },
} });

const sides = {
  php: { base: o.php, host: o.phpHost, email: 'shopper19001@example.test' },
  go: { base: o.go, host: o.goHost, email: 'shopper19002@example.test' },
};

async function call(side, method, path, { body, token, headers = {} } = {}) {
  const s = sides[side];
  const res = await fetch(`${s.base}/api/v1${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(s.host ? { Host: s.host } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, replayed: res.headers.get('idempotent-replayed') };
}

// 必然不同的值換成記號（兩邊的帳號、自動編號、亂數單號、token、時間）
function normalize(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => normalize(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, k)]));
  if (typeof v === 'string' && /^A\d{6}[A-Z0-9]{7}$/.test(v)) return '<order_no>';
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(v)) return '<time>';
  if (key === 'access_token') return '<token>';
  if (['id', 'payment_id', 'order_id', 'event_id', 'customer_id', 'refund_id', 'shipment_id'].includes(key) && v !== null) return '<id>';
  if (key === 'email' && typeof v === 'string' && v.startsWith('shopper')) return '<email>';
  if (key === 'name' && typeof v === 'string' && /^shopper/i.test(v)) return '<name>';
  if (['correlation_id', 'requested_at_ms', 'idempotency_key', 'payment_token_ref'].includes(key)) return `<${key}>`;   // 帳號各自的綁卡代號也不同
  return v;
}

const results = [];
function compare(name, a, b) {
  const na = normalize(a), nb = normalize(b);
  const ok = isDeepStrictEqual(na, nb);
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) {
    console.log('   PHP:', JSON.stringify(na).slice(0, 1500));
    console.log('   Go :', JSON.stringify(nb).slice(0, 1500));
  }
}

// 兩邊各跑一次同一個步驟，比結果
async function both(name, fn) {
  const [a, b] = [await fn('php'), await fn('go')];
  compare(name, a, b);
  return { php: a, go: b };
}

// 叢集的 MySQL（只讀）：一列一個 JSON
function sql(query) {
  // SQL 從 stdin 送進去：查詢裡的反引號（`key`）放在 sh -c 的字串裡會被當成指令
  const out = execFileSync('kubectl', ['--context', 'kind-demo-shop', '-n', 'demo-shop', 'exec', '-i', 'mysql-0', '--', 'sh', '-c',
    'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 demo -N -B 2>/dev/null'], { encoding: 'utf8', input: query });
  return out.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));   // mysql 會先印「PAGER set to stdout」之類的提示
}

const token = {};
const login = (side, password = '0204') => call(side, 'POST', '/auth/login', { body: { email: sides[side].email, password } });

await both('登入：email 格式錯、沒給密碼 → 422', (s) => call(s, 'POST', '/auth/login', { body: { email: 'bad' } }));
await both('登入：密碼錯 → 401', (s) => login(s, 'wrong'));
const ok = await both('登入成功', (s) => login(s));
token.php = ok.php.body.access_token;
token.go = ok.go.body.access_token;
await both('沒帶 token → 401', (s) => call(s, 'GET', '/cart'));
await both('亂寫的 token → 401', (s) => call(s, 'GET', '/cart', { token: 'x.y.z' }));
await both('用另一邊簽的 token（金鑰相同，要能通用）', (s) => call(s, 'GET', '/me', { token: token[s === 'php' ? 'go' : 'php'] }).then((r) => ({ status: r.status })));
await both('/me', (s) => call(s, 'GET', '/me', { token: token[s] }));
await both('商品目錄', (s) => call(s, 'GET', '/catalog'));
await both('不存在的路徑 → 404', (s) => call(s, 'GET', '/nope', { token: token[s] }));

// 從空購物車開始
for (const s of ['php', 'go']) {
  const cart = await call(s, 'GET', '/cart', { token: token[s] });
  for (const it of cart.body.items ?? []) await call(s, 'DELETE', `/cart/items/${it.id}`, { token: token[s] });
}
const variants = Object.fromEntries((await call('php', 'GET', '/catalog')).body.data.flatMap((p) => p.variants).map((v) => [v.sku, v.id]));

await both('空購物車', (s) => call(s, 'GET', '/cart', { token: token[s] }));
await both('放商品：欄位都沒給 → 422', (s) => call(s, 'PUT', '/cart/items', { token: token[s], body: {} }));
await both('放商品：qty 0、交付方式錯 → 422', (s) => call(s, 'PUT', '/cart/items', { token: token[s], body: { variant_id: variants['AK-PLUSH'], fulfillment_type: 'teleport', qty: 0 } }));
await both('放商品：商品不存在 → 422', (s) => call(s, 'PUT', '/cart/items', { token: token[s], body: { variant_id: 999999, fulfillment_type: 'direct', qty: 1 } }));
await both('放商品：狗屋不能寄倉 → 422', (s) => call(s, 'PUT', '/cart/items', { token: token[s], body: { variant_id: variants['AK-DOGHOUSE'], fulfillment_type: 'warehouse', qty: 1 } }));
await both('結帳：空購物車 → 422', (s) => call(s, 'POST', '/checkout', { token: token[s], body: {}, headers: { 'Idempotency-Key': `parity-empty-${Date.now()}-${s}` } }));
await both('放商品：絨毛玩具 ×2', (s) => call(s, 'PUT', '/cart/items', { token: token[s], body: { variant_id: variants['AK-PLUSH'], fulfillment_type: 'direct', qty: 2 } }));
await both('放商品：維他命 ×1', (s) => call(s, 'PUT', '/cart/items', { token: token[s], body: { variant_id: variants['SB-VITAMIN'], fulfillment_type: 'direct', qty: 1 } }));
await both('放商品：同一件改成 ×3（更新，不是新增）', (s) => call(s, 'PUT', '/cart/items', { token: token[s], body: { variant_id: variants['AK-PLUSH'], fulfillment_type: 'direct', qty: 3 } }));
await both('放商品：狗屋 ×2（大型物流，每件一包）', (s) => call(s, 'PUT', '/cart/items', { token: token[s], body: { variant_id: variants['AK-DOGHOUSE'], fulfillment_type: 'direct', qty: 2 } }));
await both('刪掉維他命', async (s) => {
  const cart = await call(s, 'GET', '/cart', { token: token[s] });
  const id = cart.body.items.find((i) => i.variant_id === variants['SB-VITAMIN']).id;
  return call(s, 'DELETE', `/cart/items/${id}`, { token: token[s] });
});
await both('放商品：維他命 ×1（再放回去）', (s) => call(s, 'PUT', '/cart/items', { token: token[s], body: { variant_id: variants['SB-VITAMIN'], fulfillment_type: 'direct', qty: 1 } }));
await both('結帳：沒帶 Idempotency-Key → 400', (s) => call(s, 'POST', '/checkout', { token: token[s], body: {} }));
await both('結帳：utm_source 太長 → 422', (s) => call(s, 'POST', '/checkout', { token: token[s], body: { utm_source: 'x'.repeat(51) }, headers: { 'Idempotency-Key': `parity-long-${Date.now()}-${s}` } }));

const key = { php: `parity-${Date.now()}-php`, go: `parity-${Date.now()}-go` };
const corr = { php: `parity-${Date.now()}-php`, go: `parity-${Date.now()}-go` };
const placed = await both('結帳成功 → 201', (s) => call(s, 'POST', '/checkout', { token: token[s], body: { utm_source: 'parity' }, headers: { 'Idempotency-Key': key[s], 'X-Correlation-Id': corr[s] } }));
await both('同一個 key 重送 → 同一張訂單、Idempotent-Replayed: true', async (s) => {
  const r = await call(s, 'POST', '/checkout', { token: token[s], body: { utm_source: 'parity' }, headers: { 'Idempotency-Key': key[s] } });
  return { ...r, sameOrder: r.body.order_no === placed[s].body.order_no };
});
await both('同一個 key、內容不同 → 422', (s) => call(s, 'POST', '/checkout', { token: token[s], body: { utm_source: 'other' }, headers: { 'Idempotency-Key': key[s] } }));
await both('結帳後購物車是空的', (s) => call(s, 'GET', '/cart', { token: token[s] }));
await both('service-token：金鑰錯 → 401', (s) => call(s, 'POST', '/auth/service-token', { body: { customer_id: 1 }, headers: { 'X-Service-Key': 'wrong' } }));
if (o.bffKey) {
  await both('service-token：顧客不存在 → 404', (s) => call(s, 'POST', '/auth/service-token', { body: { customer_id: 99999999 }, headers: { 'X-Service-Key': o.bffKey } }));
  await both('service-token：換新 token', (s) => call(s, 'POST', '/auth/service-token', { body: { customer_id: 1 }, headers: { 'X-Service-Key': o.bffKey } }));
}

// ── 寫進資料庫的內容 ──
const orderNo = { php: placed.php.body.order_no, go: placed.go.body.order_no };
const db = (s) => {
  const no = orderNo[s];
  const order = sql(`SELECT JSON_OBJECT('status', status, 'subtotal', subtotal, 'shipping_fee', shipping_fee, 'discount', discount, 'total', total,
    'subscription_id', subscription_id, 'utm_source', utm_source, 'utm_medium', utm_medium, 'utm_campaign', utm_campaign, 'correlation_id', correlation_id,
    'paid_at', paid_at) FROM orders WHERE order_no = '${no}'`)[0];
  const items = sql(`SELECT JSON_OBJECT('variant_id', variant_id, 'sku', sku, 'product_name', product_name, 'unit_price', unit_price, 'qty', qty,
    'line_total', line_total, 'brand_id', brand_id, 'legal_entity_id', legal_entity_id, 'commission_bps', commission_bps, 'shipping_class', shipping_class,
    'fulfillment_type', fulfillment_type, 'fulfillment_status', fulfillment_status, 'appointment_at', appointment_at, 'refunded_qty', refunded_qty)
    FROM order_items WHERE order_id = (SELECT id FROM orders WHERE order_no = '${no}') ORDER BY id`);
  const payment = sql(`SELECT JSON_OBJECT('amount', amount, 'refunded_amount', refunded_amount, 'capture_mode', capture_mode, 'key_matches', idempotency_key = CONCAT('pay:', '${no}'))
    FROM payments WHERE order_id = (SELECT id FROM orders WHERE order_no = '${no}')`)[0];
  const outbox = sql(`SELECT JSON_OBJECT('type', type, 'queue', queue, 'attempts_ok', attempts >= 0, 'payload', payload)
    FROM outbox_messages WHERE correlation_id = '${corr[s]}' AND type = 'payment.requested'`);   // payload 是 JSON 欄位，JSON_OBJECT 直接帶出物件
  const reservations = sql(`SELECT JSON_OBJECT('variant_id', variant_id, 'qty', SUM(qty), 'status', MIN(status), 'ttl_seconds', TIMESTAMPDIFF(SECOND, MIN(created_at), MIN(expires_at)))
    FROM inventory_reservations WHERE order_id = (SELECT id FROM orders WHERE order_no = '${no}') GROUP BY variant_id ORDER BY variant_id`);
  const idem = sql(`SELECT JSON_OBJECT('request_hash', request_hash, 'response_code', response_code) FROM idempotency_keys WHERE \`key\` = '${key[s]}'`)[0];
  // 付款狀態會被背景程式往前推（PENDING → SUBMITTED → SUCCEEDED），這裡只比建立當下就確定的欄位
  return { order: { ...order, status: undefined, paid_at: undefined }, items: items.map((i) => ({ ...i, fulfillment_status: undefined })), payment, outbox, reservations, idem };
};
compare('資料庫：訂單、明細、付款、outbox、庫存預留、冪等鍵', db('php'), db('go'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}／${results.length} 項一致`);
process.exit(failed.length ? 1 : 0);
