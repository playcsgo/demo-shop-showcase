#!/usr/bin/env bash
# 經銷商服務：和商店完全分開，不需要商店在跑
#   scripts/distributor.sh up      啟動（第一次會裝套件、建資料庫、放 demo 資料）
#   scripts/distributor.sh reset   清空資料庫，重建 demo 資料
#   scripts/distributor.sh test    後端測試和 PHPStan
#   scripts/distributor.sh down    停止（資料留著）
set -euo pipefail
cd "$(dirname "$0")/.."

dc() { docker compose -f compose.distributor.yaml "$@"; }
api() { dc exec -T distributor-api "$@"; }

prepare() {
  [[ -f services/distributor/api/.env ]] || cp services/distributor/api/.env.example services/distributor/api/.env
  dc up -d --build
  [[ -d services/distributor/api/vendor ]] || api composer install --no-interaction --no-progress
  grep -q '^APP_KEY=base64' services/distributor/api/.env || api php artisan key:generate --force
  api php artisan migrate --force
}

case "${1:-up}" in
  up)
    prepare
    api php artisan db:seed --force
    echo
    echo "  經銷商前台  http://localhost:${DISTRIBUTOR_WEB_PORT:-25173}"
    echo "  員工後台    http://localhost:${DISTRIBUTOR_API_PORT:-28080}/admin"
    ;;
  reset)
    prepare
    api php artisan migrate:fresh --seed --force
    ;;
  test)
    api ./vendor/bin/pest "${@:2}"
    api ./vendor/bin/phpstan analyse --memory-limit=1G --no-progress
    ;;
  down)
    dc down
    ;;
  *)
    echo "用法：$0 up|reset|test|down" >&2
    exit 1
    ;;
esac
