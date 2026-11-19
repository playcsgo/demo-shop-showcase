#!/usr/bin/env bash
# 冒煙測試：登入 → 購物車（混合品牌、直送＋寄倉）→ 結帳（重送同一個冪等鍵）→ 付款 → 訂單詳情
#           → 預約（TCC：保留 → 授權 → 醫院確認 → 請款）單獨結帳
# 每一步都核對「API 預期行為 vs 實際結果」，印 ✅／❌；有任何 ❌ 就回傳 1
# 用法：scripts/smoke.sh [--manual-pay]   （--manual-pay：用 dev:pay 模擬付款，給 M4 用；M7 之後由 hub＋mock 金流自動完成）
set -uo pipefail
B=${CORE_URL:-http://localhost:18080}/api/v1
PASS=0 FAIL=0
PAID_STATES='["PAID","FULFILLING","COMPLETED"]'

auth=(-H 'Content-Type: application/json' -H 'Accept: application/json')

api() { # METHOD PATH [BODY] [額外 curl 參數…] → 設定 CODE、BODY、HEADERS
  local m=$1 p=$2 d=${3-} h; shift 2; [[ $# -gt 0 ]] && shift
  h=$(mktemp)
  BODY=$(curl -s -X "$m" "$B$p" "${auth[@]}" -D "$h" ${d:+-d "$d"} "$@")
  CODE=$(awk 'NR==1{print $2}' "$h"); HEADERS=$(tr -d '\r' <"$h"); rm -f "$h"
}
j() { jq -r "$@" <<<"$BODY" 2>/dev/null || echo '(回應不是 JSON)'; }

check() { # 說明 預期 實際
  if [[ "$2" == "$3" ]]; then echo "  ✅ $1"; PASS=$((PASS + 1))
  else echo "  ❌ $1：預期 $2，實際 $3"; FAIL=$((FAIL + 1)); fi
}
summary() {
  echo "== 結果：✅ $PASS  ❌ $FAIL"
  [[ $FAIL -eq 0 ]]
}
abort() { echo "  ⛔ $1，後面的步驟沒辦法繼續"; summary; exit 1; }

wait_paid() { # 訂單編號 → 等到不是 PENDING_PAYMENT（最多 30 秒），BODY 留在最後一次的訂單詳情
  for _ in $(seq 1 30); do
    api GET "/orders/$1"
    [[ "$(j .status)" != "PENDING_PAYMENT" ]] && return; sleep 1
  done
}

echo "== 登入"
api POST /auth/login '{"email":"alice@example.test","password":"0204"}'
check "登入回 200" 200 "$CODE"
TOKEN=$(j '.access_token // empty')
[[ -n "$TOKEN" ]] || abort "沒有拿到 access_token"
auth+=(-H "Authorization: Bearer $TOKEN")

api GET /catalog
CATALOG=$BODY
vid() { jq -r --arg sku "$1" '.data[].variants[] | select(.sku==$sku) | .id' <<<"$CATALOG"; }

put() { # sku type qty [appointment]
  local v body
  v=$(vid "$1")
  [[ -n "$v" ]] || { check "商品 $1 在目錄裡" "有" "找不到"; return; }
  body=$(jq -nc --argjson v "$v" --arg t "$2" --argjson q "$3" --arg a "${4:-}" \
    '{variant_id:$v, fulfillment_type:$t, qty:$q} + (if $a=="" then {} else {appointment_at:$a} end)')
  api PUT /cart/items "$body"
  # 這次請求才建立購物車時，Laravel 會自動回 201（回傳的是購物車本身）
  check "加入購物車 $1 ($2 ×$3)" true "$([[ $CODE == 200 || $CODE == 201 ]] && echo true || echo "false（${CODE}）")"
}

echo "== 購物車"
put DCS-DH-M direct 1
put DCS-LIT-1 direct 2
put DCS-CAL-60 direct 1
put DCS-DCAN-BEEF-165 direct 1
put DCS-CAN-DUCK-80 warehouse 10
api GET /cart
CART_SUBTOTAL=$(j .subtotal); CART_QTY=$(j '[.items[].qty] | add')

echo "== 結帳（同一個 Idempotency-Key 送兩次）"
KEY="chk-$(date +%s)"
api POST /checkout '{"utm_source":"line","utm_campaign":"1111"}' -H "Idempotency-Key: $KEY"
R1=$BODY
check "第一次結帳回 201" 201 "$CODE"
ORDER=$(j '.order_no // empty')
[[ -n "$ORDER" ]] || abort "結帳沒有回訂單編號（$(j '.message // .' | head -c 200)）"
j '"  訂單 \(.order_no)  \(.status)  小計 \(.subtotal) + 運費 \(.shipping_fee) = \(.total)"'
check "新訂單狀態是 PENDING_PAYMENT" PENDING_PAYMENT "$(j .status)"
check "小計 = 購物車小計" "$CART_SUBTOTAL" "$(j .subtotal)"
check "總額 = 小計 + 運費" "$(j '.subtotal + .shipping_fee')" "$(j .total)"
check "訂單件數 = 購物車件數" "$CART_QTY" "$(j '[.items[].qty] | add')"
check "冪等鍵第一次：Idempotent-Replayed 是 false" false "$(grep -i '^idempotent-replayed:' <<<"$HEADERS" | awk '{print $2}')"

api POST /checkout '{"utm_source":"line","utm_campaign":"1111"}' -H "Idempotency-Key: $KEY"
check "第二次（重送）回 201" 201 "$CODE"
check "第二次回同一張訂單" "$ORDER" "$(j .order_no)"
check "第二次：Idempotent-Replayed 是 true" true "$(grep -i '^idempotent-replayed:' <<<"$HEADERS" | awk '{print $2}')"
api GET /orders
check "訂單列表裡這張只出現一次" 1 "$(j --arg o "$ORDER" '[.data[] | select(.order_no==$o)] | length')"

if [[ "${1:-}" == "--manual-pay" ]]; then
  echo "== 模擬付款（dev:pay，送兩次）"
  docker compose exec -T core-api php artisan dev:pay "$ORDER"
  docker compose exec -T core-api php artisan dev:pay "$ORDER"
  api GET "/orders/$ORDER"
else
  echo "== 等待付款完成（hub＋mock 金流）"
  wait_paid "$ORDER"
fi
check "付款後狀態是 PAID 之後的狀態" true "$(j --argjson ok "$PAID_STATES" '.status as $s | $ok | index($s) != null')"
check "有付款時間 paid_at" true "$(j '.paid_at != null')"

echo "== 訂單詳情（交付卡片）"
j '"  狀態 \(.status)  進度 \(.progress.done)/\(.progress.total)",
  (.fulfillments[] | "  - [\(.type)] \(.title) \(.carrier // "") \(.status) \([.items[]? | "\(.name)×\(.qty)"] | join("、")) \(.appointment_at // "")")'
check "交付卡片的件數加總 = 訂單件數" "$CART_QTY" "$(j '[.fulfillments[] | .items[]?.qty] | add')"
check "寄倉卡片 1 張、10 件" "1/10" "$(j '[.fulfillments[] | select(.type=="warehouse")] | "\(length)/\([.[].items[].qty] | add)"')"
check "直送的商品都有包裹卡片" true "$(j '[.fulfillments[] | select(.type=="shipment")] | length > 0')"
check "進度的分母 = 卡片數" "$(j '.fulfillments | length')" "$(j .progress.total)"

if [[ "${1:-}" != "--manual-pay" ]]; then
  echo "== 預約健康檢查（TCC，單獨結帳）"
  SLOT=$(date -v+3d +%Y-%m-%dT14:00:00+08:00 2>/dev/null || date -d '+3 days' +%Y-%m-%dT14:00:00+08:00)
  put DCS-SVC-HEALTH booking 1 "$SLOT"
  api GET /cart
  j '.items[] | "  醫院保留到 \(.hold_expires_at)"'
  check "加入購物車就向醫院保留時段（有 hold_expires_at）" true "$(j '[.items[] | select(.hold_expires_at != null)] | length == 1')"
  api POST /checkout '{}' -H "Idempotency-Key: bk-$(date +%s)"
  check "預約結帳回 201" 201 "$CODE"
  BOOKING=$(j '.order_no // empty')
  [[ -n "$BOOKING" ]] || abort "預約結帳沒有回訂單編號（$(j '.message // .' | head -c 200)）"
  # 付款狀態更新之後，醫院確認、請款還要一點時間：等預約卡片完成
  for _ in $(seq 1 30); do
    api GET "/orders/$BOOKING"
    [[ "$(j '[.fulfillments[] | select(.type=="booking") | .done] | all')" == true && "$(j .status)" != PENDING_PAYMENT ]] && break
    sleep 1
  done
  j '"  訂單 \(.order_no) \(.status)  總額 \(.total)",
    (.fulfillments[] | "  - [\(.type)] \(.title) \(.status) \(.appointment_at)")'
  check "預約訂單已付款" true "$(j --argjson ok "$PAID_STATES" '.status as $s | $ok | index($s) != null')"
  check "預約卡片 1 張、狀態 CONFIRMED" "1/CONFIRMED" "$(j '[.fulfillments[] | select(.type=="booking")] | "\(length)/\(.[0].status)"')"
  check "預約時段 = 送出的時段" "$SLOT" "$(j '.fulfillments[] | select(.type=="booking") | .appointment_at')"
  check "預約沒有運費" 0 "$(j .shipping_fee)"
fi

summary || exit 1
echo "$ORDER"
