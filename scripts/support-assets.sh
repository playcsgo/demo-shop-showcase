#!/usr/bin/env bash
# 「你是 AI 嗎」的固定圖片有版權，不進 Git。從 repo 外複製到 services/support/api/assets/
set -euo pipefail
cd "$(dirname "$0")/.."
src="${1:-../refernce_info/我是超級AI.jpeg}"
[[ -f "$src" ]] || { echo "找不到圖片：$src（可以傳路徑當參數）" >&2; exit 1; }
mkdir -p services/support/api/assets
cp "$src" services/support/api/assets/super-ai.jpeg
echo "已複製到 services/support/api/assets/super-ai.jpeg"
