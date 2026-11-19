#!/usr/bin/env bash
# 啟動 demo（M14）：依根目錄 .env 的開關決定要不要開「本機 debug log」和「Datadog」
#   DEBUG_LOG=TRUE → 加開 Alloy、Loki、Grafana（compose profile: logs）
#   DATA_DOG=TRUE  → 疊加 compose.datadog.yaml（Agent＋各服務的 DD_* 設定）
# 沒開的部分會被停掉（資料在 volume 裡，不會遺失）。其他參數原樣交給 docker compose up，例如：scripts/up.sh --build
set -euo pipefail
cd "$(dirname "$0")/.."

flag() { # 讀 .env 的開關；TRUE／true／1／yes／on 都算開
  local v; v=$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' " | tr '[:upper:]' '[:lower:]')
  [[ "$v" =~ ^(true|1|yes|on)$ ]]
}

files=(-f compose.yaml)
profiles=()
flag DATA_DOG && files+=(-f compose.datadog.yaml)
# WEB_RUNTIME=next：bff-gateway 換成 Next.js 版（同時提供頁面），Vite 前台不啟動
web=$( (grep -E '^WEB_RUNTIME=' .env 2>/dev/null || true) | tail -1 | cut -d= -f2- | tr -d "\"' " | tr '[:upper:]' '[:lower:]')
[[ "$web" == next ]] && files+=(-f compose.next.yaml)
flag DEBUG_LOG && profiles+=(--profile logs)

# --remove-orphans：DATA_DOG 從開變關時，把 datadog-agent 移掉；各服務的 DD_* 設定改變 → compose 自動重建
# 換版時兩邊搶同一個 port（15173）：先把另一版佔著的容器拿掉
if [[ "$web" == next ]]; then docker compose rm -sf storefront >/dev/null 2>&1 || true; fi
docker compose "${files[@]}" "${profiles[@]+"${profiles[@]}"}" up -d --remove-orphans "$@"

if ! flag DEBUG_LOG; then
  docker compose --profile logs rm -sf alloy loki grafana >/dev/null 2>&1 || true
fi

echo
echo "  前台        http://localhost:15173   （$([[ "$web" == next ]] && echo "Next.js：services/web-next" || echo "Vite＋NestJS BFF")，.env 的 WEB_RUNTIME）"
echo "  後台        http://localhost:18080/admin"
echo "  廠商控制台  http://localhost:14000"
flag DEBUG_LOG && echo "  debug log   http://localhost:13300   （LOG_LEVEL=$(grep -E '^LOG_LEVEL=' .env | cut -d= -f2)，保存 $(grep -E '^LOKI_RETENTION=' .env | cut -d= -f2)）" || echo "  debug log   關閉（.env 的 DEBUG_LOG）"
flag DATA_DOG && echo "  Datadog     開啟（https://$(grep -E '^DD_SITE=' .env | cut -d= -f2)）" || echo "  Datadog     關閉（.env 的 DATA_DOG）"
