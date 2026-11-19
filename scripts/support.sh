#!/usr/bin/env bash
# AI 客服服務：商店的一個功能，要先開商店（scripts/up.sh）；測試用假的商店，不用開
#   scripts/support.sh up          啟動（第一次會建資料庫、放 demo 帳號；在商店建 DEMO-A～E）
#   scripts/support.sh down        停止（資料留著）
#   scripts/support.sh reset       清空 support 的資料庫（對話、提案），重建 demo 帳號；商店的訂單不動
#   scripts/support.sh test        單元和資料庫測試（假 CLI、假商店，不花額度）、型別檢查、lint
#   scripts/support.sh isolation   真實模型的隔離測試（花額度）
#   scripts/support.sh latency     真實模型的速度實測（花額度）
#   scripts/support.sh llm <名稱>  真實模型的情境測試，例如 ask（花額度）
set -euo pipefail
cd "$(dirname "$0")/.."

dc() { docker compose -f compose.support.yaml "$@"; }
run() { dc run --rm -T support "$@"; }

[[ -f services/support/api/.env ]] || { echo "先複製 services/support/api/.env.example 成 .env，填入 token" >&2; exit 1; }

# AI 客服是商店的功能（AIC-014）：商品、訂單、退款都在 core-api，商店沒開就不啟動
need_shop() {
  docker network inspect demo-claude_default >/dev/null 2>&1 \
    && [[ -n "$(docker compose -f compose.yaml ps -q core-api 2>/dev/null)" ]] \
    || { echo "商店沒有在跑：先執行 scripts/up.sh" >&2; exit 1; }
}
# demo 用的訂單 DEMO-A～E 建在商店裡（可重跑）
demo_orders() { docker compose -f compose.yaml exec -T core-api php artisan support:demo-orders; }

case "${1:-}" in
  up)
    need_shop
    dc build --quiet
    dc up -d --wait support-mysql
    run sh -c 'npm run db migrate && node dist/src/db/cli.js seed'
    dc up -d
    demo_orders
    echo
    echo "  客戶前台  http://localhost:${SUPPORT_WEB_PORT:-36173}"
    echo "  客服控制台 http://localhost:${SUPPORT_WEB_PORT:-36173}/console"
    ;;
  down) dc down ;;
  reset)
    need_shop
    dc build --quiet support
    dc up -d --wait support-mysql
    dc exec -T support-mysql mysql -uroot -proot -e 'DROP DATABASE IF EXISTS support; CREATE DATABASE support CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;' 2>/dev/null
    run sh -c 'npm run db migrate && node dist/src/db/cli.js seed'
    demo_orders
    ;;
  test)
    dc build --quiet support
    run sh -c 'npx vitest run && npx tsc --noEmit && npm run --silent lint'
    ;;
  isolation) dc build --quiet support; run npm run --silent llm:isolation ;;
  latency) dc build --quiet support; run npm run --silent llm:latency ;;
  llm) dc build --quiet support; run npm run --silent "llm:${2:?用法：$0 llm <ask|...>}" ;;
  *) echo "用法：$0 up|down|reset|test|isolation|latency|llm <名稱>" >&2; exit 1 ;;
esac
