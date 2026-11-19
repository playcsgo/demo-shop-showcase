#!/usr/bin/env bash
# 確認經銷商和商店沒有被綁在一起。有人把它們綁回去時，這支會失敗
set -euo pipefail
cd "$(dirname "$0")/.."

pass() { printf '  ✅ %s\n' "$1"; }
fail() { printf '  ❌ %s\n' "$1"; exit 1; }

BASE="${1:-main}"
SHOP_PATHS=(services/core-api services/bff-gateway services/storefront services/hub services/partners compose.yaml loadtest scenarios deploy infra)

changed=$( { git diff --name-only "$BASE" -- "${SHOP_PATHS[@]}"; git ls-files --others --exclude-standard -- "${SHOP_PATHS[@]}"; } | sort -u)
[[ -z "$changed" ]] && pass "商店的服務、compose、壓測腳本都沒有被改動" || { echo "$changed"; fail "商店被改動了"; }

services=$(docker compose -f compose.distributor.yaml config --services)
echo "$services" | grep -qv '^distributor-' && fail "經銷商的 compose 帶了其他服務：$services" || pass "經銷商的 compose 只有自己的服務"

docker compose -f compose.yaml config --services | grep -q distributor && fail "商店的 compose 帶了經銷商" || pass "商店的 compose 沒有經銷商"

grep -rlE '(core-nginx|core-api:|bff-gateway|localstack|proxysql|redis://|REDIS_HOST)' services/distributor compose.distributor.yaml \
  --exclude-dir=docs --exclude=README.md --exclude-dir=vendor --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=storage --exclude-dir=public --exclude=composer.lock --exclude=.env --exclude='redis.php' --exclude=database.php --exclude=cache.php --exclude=session.php --exclude=queue.php --exclude=logging.php \
  && fail "經銷商的程式提到商店的服務" || pass "經銷商的程式沒有呼叫商店的服務"

ps=$(docker compose -f compose.distributor.yaml ps --format '{{.Service}}')
if [[ -n "$ps" ]]; then
  port="${DISTRIBUTOR_API_PORT:-28080}"
  curl -sf "http://localhost:$port/up" >/dev/null && pass "經銷商服務健康" || fail "經銷商服務沒有回應"
  networks=$(docker network ls --format '{{.Name}}' | grep -c '^demo-distributor_' || true)
  [[ "$networks" -ge 1 ]] && pass "經銷商有自己的 Docker 網路" || fail "找不到經銷商的 Docker 網路"
  docker inspect "$(docker compose -f compose.distributor.yaml ps -q distributor-api)" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
    | grep -qv 'demo-distributor_' && fail "經銷商的容器連到別的網路" || pass "經銷商的容器只在自己的網路裡"
else
  echo "  ⏭  經銷商沒有在跑，略過執行中的檢查"
fi
