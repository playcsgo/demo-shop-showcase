// 連線數實驗（system-design §12.2）：大量同時請求打「需要查資料庫」的 API
// 每個 FPM worker 處理請求時會佔用一條 MySQL 連線 → 同時在處理的請求數 ≈ 同時開著的連線數
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE || 'http://core-nginx';
const VUS = Number(__ENV.VUS || 250);

export const options = {
  scenarios: {
    burst: { executor: 'constant-vus', vus: VUS, duration: __ENV.DURATION || '40s' },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

// 先讓 30 個顧客登入，拿到 JWT
export function setup() {
  const tokens = [];
  for (let i = 1; i <= 30; i++) {
    const n = String(i).padStart(2, '0');
    const res = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email: `shopper${n}@example.test`, password: '0204' }),
      { headers: { 'Content-Type': 'application/json' } });
    tokens.push(res.json('access_token'));
  }
  return { tokens };
}

export default function (data) {
  const token = data.tokens[__VU % data.tokens.length];
  const params = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: '30s' };
  // 會員中心常見的兩支：訂單列表、購物車（都要查資料庫）
  const res = __ITER % 2 === 0 ? http.get(`${BASE}/api/v1/orders`, params) : http.get(`${BASE}/api/v1/cart`, params);
  check(res, { 'status 200': (r) => r.status === 200 });
}
