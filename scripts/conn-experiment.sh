#!/usr/bin/env bash
# 連線數實驗（system-design §12.2）
#   A：沒有預算 → 8 個 core-api × 20 FPM worker = 160 條 > MySQL 上限 150
#   B：照預算   → 5 個 core-api × 20 FPM worker = 100 條（＋relay／worker／scheduler 約 3 條）< 150
#   C：連線池   → 和 A 一樣 8 × 20 = 160，但經過 ProxySQL（後端最多 100 條）：容器可以多開，MySQL 的連線數不會爆
#   A、B 直連 MySQL（平常 core 都經過 ProxySQL，這裡刻意繞過，才重現得出沒有連線池時的問題）
# 用法：scripts/conn-experiment.sh A|B|C
set -euo pipefail
cd "$(dirname "$0")/.."
GROUP=${1:?用法：scripts/conn-experiment.sh A|B|C}
case "$GROUP" in
  A) REPLICAS=8; DB=mysql:3306 ;;
  B) REPLICAS=5; DB=mysql:3306 ;;
  C) REPLICAS=8; DB=proxysql:6033 ;;
  *) echo "只有 A、B、C"; exit 1 ;;
esac
CHILDREN=20
LATENCY_MS=${LATENCY_MS:-50}   # 模擬每個請求佔用連線的時間（查詢變慢）
OUT=loadtest/results; mkdir -p "$OUT"
mysql() { docker compose exec -T mysql mysql -N -uroot -proot -e "$1" 2>/dev/null; }

echo "== 第 $GROUP 組：core-api × ${REPLICAS}，每個 FPM $CHILDREN 個 worker → 最多 $((REPLICAS * CHILDREN)) 條連線（MySQL 上限 150），連到 ${DB}；每個請求佔用連線 ${LATENCY_MS} ms"
CORE_DB_HOST=${DB%%:*} CORE_DB_PORT=${DB##*:} FPM_MAX_CHILDREN=$CHILDREN DEMO_DB_LATENCY_MS=$LATENCY_MS docker compose up -d --scale core-api=$REPLICAS --force-recreate core-api >/dev/null 2>&1
docker compose exec -T core-nginx nginx -s reload >/dev/null   # 讓 nginx 重新解析，把新的 core-api 都加進來
sleep 3
# Connection_errors_max_connections 是全域累計值（FLUSH STATUS 不會重設）→ 記下實驗前的值，最後相減
ERRORS_BEFORE=$(mysql "SHOW GLOBAL STATUS LIKE 'Connection_errors_max_connections'" | awk '{print $2}')

# 每 0.5 秒取樣 MySQL 連線數（背景執行）
SAMPLES="$OUT/$GROUP-threads.txt"; : > "$SAMPLES"
( while true; do mysql "SHOW GLOBAL STATUS LIKE 'Threads_connected'" | awk '{print $2}' >> "$SAMPLES"; sleep 0.5; done ) >/dev/null 2>&1 &
SAMPLER=$!
disown $SAMPLER
trap 'kill $SAMPLER 2>/dev/null || true' EXIT

docker run --rm --network demo-claude_default -v "$PWD/loadtest:/scripts" grafana/k6:latest run \
  -e BASE=http://core-nginx -e VUS=250 -e DURATION=40s \
  --summary-export "/scripts/results/$GROUP-summary.json" /scripts/connections.js >/dev/null 2>&1 || true
kill $SAMPLER 2>/dev/null || true

ERRORS_1040=$(( $(mysql "SHOW GLOBAL STATUS LIKE 'Connection_errors_max_connections'" | awk '{print $2}') - ERRORS_BEFORE ))
MAX_THREADS=$(sort -n "$SAMPLES" | tail -1)
jq -r --arg g "$GROUP" --arg r "$REPLICAS" --arg max "$MAX_THREADS" --arg e "$ERRORS_1040" '
  "  請求數       \(.metrics.http_reqs.count)",
  "  失敗率       \((.metrics.http_req_failed.value * 100 * 100 | round) / 100)%",
  "  P50／P95     \(.metrics.http_req_duration["p(50)"] | round) ms ／ \(.metrics.http_req_duration["p(95)"] | round) ms",
  "  每秒請求     \(.metrics.http_reqs.rate | round)",
  "  MySQL 最高連線數  \($max)",
  "  連線被拒（1040）  \($e) 次"' "$OUT/$GROUP-summary.json" | tee "$OUT/$GROUP-report.txt"

echo "== 還原成 1 個 core-api（經過 ProxySQL）"
DEMO_DB_LATENCY_MS=0 docker compose up -d --scale core-api=1 --force-recreate core-api >/dev/null 2>&1
docker compose exec -T core-nginx nginx -s reload >/dev/null 2>&1
