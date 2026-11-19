// sandbox 情境共用的 k6 程式：登入、購物車、結帳、預約
//
// 每個請求都帶上「看得懂、每次都一樣」的 correlation_id：s<seed>-u<第幾個虛擬使用者>-i<第幾輪>-<動作>
//   例：s42-u17-i3-checkout ＝ seed 42、第 17 個客人、第 3 輪、結帳
//   partners 用「seed＋correlation_id」決定要不要注入故障 → 同一個 seed 重跑，同一筆遇到同樣的故障
// 隨機的選擇（買什麼、買幾個、哪個時段）也由 seed＋這一輪決定，不用 Math.random
//
// 環境變數（runner 傳進來）：BASE、SEED、ONLY（重現：只跑某一輪，例如 s42-u17-i3）
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

export const BASE = __ENV.BASE || 'http://core-nginx/api/v1';
// 經過入口（K8s 的 Traefik）時要帶 Host：入口依 Host 決定轉給哪個服務；入口是每個請求分配一次 Pod，擴充出來的 Pod 馬上分得到流量
const HOST = __ENV.HOST || '';
export const SEED = __ENV.SEED || '0';
const ONLY = __ENV.ONLY || '';

export const unexpected = new Counter('unexpected_responses');   // 不在預期內的回應（runner 會列出 correlation_id）

/** 這一輪的身分：s42-u17-i3 */
export const flow = () => `s${SEED}-u${__VU}-i${__ITER}`;

/** 重現模式：只跑指定的那一輪，其他直接跳過 */
export const skipped = () => ONLY !== '' && ONLY !== flow();

/** 0～1，由 seed＋這一輪＋用途決定（每次跑都一樣） */
export function rand(label) {
  return parseInt(crypto.sha256(`${SEED}|${flow()}|${label}`, 'hex').slice(0, 8), 16) / 0x100000000;
}
export const pick = (label, list) => list[Math.floor(rand(label) * list.length)];

let token = null;   // 每個虛擬使用者各自一份（k6 的每個 VU 是獨立的 JS 環境）
let sid = null;     // 走 BFF 時的登入狀態：自己帶 cookie，因為 k6 預設每一輪都會清 cookie jar

function headers(action, extra = {}) {
  return Object.assign(HOST ? { Host: HOST } : {}, {
    'Content-Type': 'application/json', Accept: 'application/json',
    'X-Correlation-Id': `${flow()}-${action}`,
  }, token ? { Authorization: `Bearer ${token}` } : {}, sid ? { Cookie: `sid=${sid}` } : {}, extra);
}

/** 請求的種類（壓測報告分開統計用）：放商品不分是哪個商品，但預約要問醫院有沒有空位，跟一般商品分開 */
const step = (action) => (action === 'put-DCS-SVC-HEALTH' ? 'put-booking' : action.startsWith('put-') ? 'put' : action);

/**
 * 送出請求；回應不在 expected 裡 → 記一筆 FAILED_REQUEST（runner 從 k6 的輸出撈出來放進報告）
 */
export function call(method, path, body, action, expected = [200, 201], extraHeaders = {}) {
  const send = () => http.request(method, `${BASE}${path}`, body === null ? null : JSON.stringify(body), { headers: headers(action, extraHeaders), tags: { action, step: step(action) } });
  let res = send();
  if (res.status === 401 && action !== 'login') { token = null; sid = null; login(); res = send(); }   // JWT 15 分鐘過期（耐久測試會遇到）
  const ok = expected.includes(res.status);
  check(res, { [`${action} ${expected.join('/')}`]: () => ok });
  if (!ok) {
    unexpected.add(1, { action });
    console.log(`FAILED_REQUEST ${JSON.stringify({ correlation_id: `${flow()}-${action}`, action, status: res.status, body: String(res.body).slice(0, 300) })}`);
  }
  return res;
}

/** 第 N 個虛擬使用者用 shopperN 登入（data.env 的 CUSTOMERS 要 ≥ 虛擬使用者數） */
export function login() {
  if (token || sid) return;
  const n = String(__VU).padStart(2, '0');
  const res = call('POST', '/auth/login', { email: `shopper${n}@example.test`, password: '0204' }, 'login');
  token = res.json('access_token') || null;   // 直連 core：回應裡有 JWT
  sid = res.cookies.sid?.[0]?.value ?? null;  // 走 BFF：JWT 留在伺服器端，只回 httpOnly cookie
}

/** 每一輪開始先清空購物車：上一輪失敗留下的東西不會影響這一輪（每一輪都能單獨重現） */
export function clearCart() {
  const cart = call('GET', '/cart', null, 'cart');
  for (const item of cart.json('items') || []) call('DELETE', `/cart/items/${item.id}`, null, 'cart-clear');
}

export function catalog() {
  const res = http.get(`${BASE}/catalog`, { headers: Object.assign(HOST ? { Host: HOST } : {}, { Accept: 'application/json' }) });
  const bySku = {};
  for (const p of res.json('data')) for (const v of p.variants) bySku[v.sku] = v.id;
  return bySku;
}

export function put(skus, sku, type, qty, extra = {}, expected = [200, 201]) {
  return call('PUT', '/cart/items', Object.assign({ variant_id: skus[sku], fulfillment_type: type, qty }, extra), `put-${sku}`, expected);
}

/** 結帳；doubleClick：同一個 Idempotency-Key 再送一次（模擬連按兩下） */
export function checkout(expected = [200, 201], doubleClick = false) {
  const key = `${flow()}-checkout`;
  const res = call('POST', '/checkout', { utm_source: 'sandbox' }, 'checkout', expected, { 'Idempotency-Key': key });
  if (doubleClick) call('POST', '/checkout', { utm_source: 'sandbox' }, 'checkout', expected.concat([409]), { 'Idempotency-Key': key });
  return res;
}

/** 預約一個時段（seed 決定日期時間）；額滿或醫院暫時不能用就換時段，最多 3 次 */
export function book(skus) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const day = 1 + Math.floor(rand(`book-day-${attempt}`) * 30);
    const hour = 10 + Math.floor(rand(`book-hour-${attempt}`) * 8);
    const at = new Date(Date.now() + day * 86400000);
    at.setUTCHours(hour - 8, 0, 0, 0);   // 台北時間 hour 點
    const res = put(skus, 'DCS-SVC-HEALTH', 'booking', 1, { appointment_at: at.toISOString() }, [200, 201, 409, 503]);
    if (res.status === 200 || res.status === 201) return true;
  }
  return false;
}

/**
 * 一般的購物流程：70% 直送商品、15% 寄倉、15% 預約（預約一定單獨結帳）
 * directOnly：只買直送商品（量訂單流程本身的速度：沒有寄倉、預約的分支）
 * 結帳之外的故障（金流、物流、醫院確認）發生在背景，由 runner 最後檢查不變式
 */
export function shop(skus, { doubleClickRate = 0.2, directOnly = false } = {}) {
  const r = rand('kind');   // 照樣抽一次：同一個 seed 之後的亂數順序不變
  const kind = directOnly ? 1 : r;
  // 之後這一輪的請求都帶 pay 標籤：預約先授權、確認後才請款（manual），其他直接扣款（auto）。壓測報告的結帳時間只算 auto
  exec.vu.metrics.tags.pay = kind < 0.15 ? 'manual' : 'auto';
  clearCart();
  if (kind < 0.15) {
    if (!book(skus)) return;   // 醫院一直額滿：這一輪就不下單（不算錯）
  } else if (kind < 0.30) {
    put(skus, 'DCS-CAN-DUCK-80', 'warehouse', 1 + Math.floor(rand('wh-qty') * 5));
  } else {
    const direct = ['DCS-CAL-60', 'DCS-DCAN-BEEF-165', 'DCS-PRO-30', 'DCS-JNT-60', 'DCS-LIT-1', 'DCS-GRASS-3', 'DCS-WAND-1', 'DCS-MAT-1', 'DCS-DH-M'];
    const n = 1 + Math.floor(rand('n-items') * 3);
    const chosen = new Set();
    for (let i = 0; i < n; i++) chosen.add(pick(`sku-${i}`, direct));
    for (const sku of chosen) put(skus, sku, 'direct', 1 + Math.floor(rand(`qty-${sku}`) * 2));
  }
  checkout([200, 201], rand('double-click') < doubleClickRate);
}
