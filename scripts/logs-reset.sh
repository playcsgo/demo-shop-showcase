#!/usr/bin/env bash
# 清空本機 debug log（M14）：刪掉 Loki 的資料，重新開始。平常不用跑，超過 LOKI_RETENTION 會自動刪除
# Alloy 保持執行：它記得每個容器讀到哪裡，Loki 清空後只會送新的 log（重建 Alloy 會把 Docker 保存的舊輸出再讀一次）
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose --profile logs rm -sf loki >/dev/null 2>&1 || true
docker volume rm demo-claude_loki-data >/dev/null 2>&1 && echo "已清空 Loki 的資料" || echo "Loki 沒有資料可清"

if grep -qiE '^DEBUG_LOG=(true|1|yes|on)' .env 2>/dev/null; then
  docker compose --profile logs up -d loki >/dev/null 2>&1
  echo "Loki 已重新啟動（Alloy 沒有重啟，會接著送新的 log）"
fi
