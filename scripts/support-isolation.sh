#!/usr/bin/env bash
# 確認 AI 客服和商店沒有被綁在一起。有人把它們綁回去時，這支會失敗
#   scripts/support-isolation.sh [比較基準，預設 main]
set -euo pipefail
cd "$(dirname "$0")/.."

pass() { printf '  ✅ %s\n' "$1"; }
fail() { printf '  ❌ %s\n' "$1"; exit 1; }

BASE="${1:-main}"
SHOP_PATHS=(services/core-api services/bff-gateway services/storefront services/hub services/partners compose.yaml loadtest scenarios deploy infra)

changed=$( { git diff --name-only "$BASE" -- "${SHOP_PATHS[@]}"; git ls-files --others --exclude-standard -- "${SHOP_PATHS[@]}"; } | sort -u)
[[ -z "$changed" ]] && pass "商店的服務、compose、壓測腳本都沒有被改動" || { echo "$changed"; fail "商店被改動了"; }

services=$(docker compose -f compose.support.yaml config --services)
echo "$services" | grep -qv '^support' && fail "AI 客服的 compose 帶了其他服務：$services" || pass "AI 客服的 compose 只有自己的服務"

docker compose -f compose.yaml config --services | grep -q '^support' && fail "商店的 compose 帶了 AI 客服" || pass "商店的 compose 沒有 AI 客服"

grep -rlE '(core-nginx|core-api|bff-gateway|localstack|proxysql|partners:|hub:|REDIS_HOST)' services/support compose.support.yaml \
  --exclude-dir=docs --exclude-dir=node_modules --exclude-dir=dist --exclude=README.md --exclude=.env --exclude=package-lock.json \
  && fail "AI 客服的程式提到商店的服務" || pass "AI 客服的程式沒有呼叫商店的服務"

ps=$(docker compose -f compose.support.yaml ps --format '{{.Service}}')
if [[ -n "$ps" ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${SUPPORT_API_PORT:-36080}/api/auth/customer/me")
  [[ "$code" == 401 ]] && pass "AI 客服服務有回應" || fail "AI 客服服務沒有回應（$code）"
  for svc in $ps; do
    docker inspect "$(docker compose -f compose.support.yaml ps -q "$svc")" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
      | tr ' ' '\n' | grep -v '^$' | grep -qv '^demo-support_' && fail "$svc 連到別的網路"
  done
  pass "AI 客服的容器只在自己的網路裡"
else
  echo "  ⏭  AI 客服沒有在跑，略過執行中的檢查"
fi
