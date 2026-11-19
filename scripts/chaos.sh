#!/usr/bin/env bash
# 混沌測試：故障注入下同時下單 → 等全部處理完 → 檢查帳是否完全一致
#   金流 30% 錯誤＋20% 重複 callback＋5% 不回、物流 20% 亂序＋20% 重複、醫院 30% 額滿
# 用法：scripts/chaos.sh [顧客數，預設 30] [--keep-data]
set -euo pipefail
cd "$(dirname "$0")/.."
SHOPPERS=${1:-30}
B=${CORE_URL:-http://localhost:18080}/api/v1
MOCK=${MOCK_URL:-http://localhost:14000}
art() { docker compose exec -T core-api php artisan "$@"; }

echo "== 重啟常駐程序（載入最新程式碼）"
docker compose restart core-relay core-worker core-scheduler hub >/dev/null 2>&1
for _ in $(seq 1 60); do curl -sf "${HUB_URL:-http://localhost:13000}/health" >/dev/null && break; sleep 2; done

if [[ "${2:-}" != "--keep-data" ]]; then
  echo "== 重設資料"
  art migrate:fresh --seed --force >/dev/null
fi
curl -sf -XPOST "$MOCK/admin/clear-log" >/dev/null
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "== 開啟混沌模式"
curl -sf -XPOST "$MOCK/admin/presets/chaos" >/dev/null

CATALOG=$(curl -sf "$B/catalog")
export B CATALOG
shopper() {
  local n; n=$(printf "%02d" "$1")
  local token; token=$(curl -sf -XPOST "$B/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"shopper$n@example.test\",\"password\":\"password\"}" | jq -r .access_token)
  local auth=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json' -H 'Accept: application/json')
  vid() { jq -r --arg s "$1" '.data[].variants[]|select(.sku==$s)|.id' <<<"$CATALOG"; }
  put() { curl -s -o /dev/null -XPUT "$B/cart/items" "${auth[@]}" -d "{\"variant_id\":$(vid "$1"),\"fulfillment_type\":\"$2\",\"qty\":$3${4:+,\"appointment_at\":\"$4\"}}"; }

  # 預約（TCC）：保留時段；額滿（409）就換一個時間，最多試 3 次
  book() {
    for _ in 1 2 3; do
      local at; at=$(date -v+$(( RANDOM % 5 + 1 ))d -v$(( RANDOM % 7 + 10 ))H +%Y-%m-%dT%H:00:00+08:00 2>/dev/null \
        || date -d "+$(( RANDOM % 5 + 1 )) days $(( RANDOM % 7 + 10 )):00" +%Y-%m-%dT%H:00:00+08:00)
      [[ $(curl -s -o /dev/null -w "%{http_code}" -XPUT "$B/cart/items" "${auth[@]}" \
        -d "{\"variant_id\":$(vid DCS-SVC-HEALTH),\"fulfillment_type\":\"booking\",\"qty\":1,\"appointment_at\":\"$at\"}") == 2* ]] && return 0
    done
    return 1
  }

  # 每個人的購物車組合不同：混合品牌、直送＋寄倉；預約單獨結帳；有人買狗屋（只有 6 個，會有人搶不到）
  case $(( $1 % 4 )) in
    0) put DCS-DH-M direct 1; put DCS-LIT-1 direct 2; put DCS-DCAN-BEEF-165 direct 1 ;;
    1) put DCS-WAND-1 direct 2; put DCS-CAN-DUCK-80 warehouse 5 ;;
    2) put DCS-GRASS-3 direct 3; put DCS-CAL-60 direct 1; put DCS-DH-M direct 1 ;;
    3) book || { echo "HOLD_FULL"; return; } ;;
  esac

  local key="chaos-$n-$RANDOM"
  local code; code=$(curl -s -o /dev/null -w "%{http_code}" -XPOST "$B/checkout" "${auth[@]}" -H "Idempotency-Key: $key" -d '{"utm_source":"chaos"}')
  # 同一個 key 再送一次（模擬使用者連按兩下）
  curl -s -o /dev/null -XPOST "$B/checkout" "${auth[@]}" -H "Idempotency-Key: $key" -d '{"utm_source":"chaos"}'
  echo "$code"
}
export -f shopper

echo "== $SHOPPERS 個顧客同時下單（每人連按兩次結帳）"
seq 1 "$SHOPPERS" | xargs -P 10 -I{} bash -c 'shopper {}' | sort | uniq -c | sed 's/^/  HTTP /'

echo "== 等待 15 秒後，隨機部分退款 5 筆（模擬客服）"
sleep 15
art dev:refund-random 5 | sed 's/^/  /'

echo "== 等待所有非同步流程處理完（最多 4 分鐘；付款 callback 遺失的會由對帳補上）"
for i in $(seq 1 120); do
  INF=$(art reconcile:check --json | jq -c .in_flight)
  if [[ $(jq '[.[]] | add' <<<"$INF") == 0 ]]; then break; fi
  (( i % 5 == 0 )) && echo "  處理中：$INF"
  sleep 2
done

echo "== 關閉混沌模式"
curl -sf -XPOST "$MOCK/admin/presets/perfect" >/dev/null

echo "== 外部廠商統計（故障、重複、遺失）"
curl -sf "$MOCK/admin/state" | jq -r '.stats | to_entries[] | select(.key|test("fault|duplicate|dropped|full|out_of_order|replay")) | "  \(.key): \(.value)"'

echo "== 重複事件被擋下的次數"
echo "  hub（第 1 層，Redis）：$(docker compose logs hub --since "$STARTED" 2>/dev/null | grep -c 'duplicate webhook' || true)"
echo "  core（第 2 層，inbox）：$(docker compose logs core-worker --since "$STARTED" 2>/dev/null | grep -c 'duplicate, skipped' || true)"

echo "== 訂單狀態"
docker compose exec -T mysql mysql -udemo -pdemo demo -e "SELECT status, COUNT(*) n FROM orders GROUP BY status" 2>/dev/null | sed 's/^/  /'

echo "== 對帳結果"
art reconcile:check
