#!/usr/bin/env bash
# sandbox 的測試套數：同一台機器開好幾套完全獨立的環境（compose.sandbox.yaml）
#
#   scripts/sandbox.sh up 1        build image（有改程式才會重做）→ 啟動第 1 套
#   scripts/sandbox.sh up 2 --no-build
#   scripts/sandbox.sh down 1      停掉並刪除第 1 套（container、網路、volume 全部清掉）
#   scripts/sandbox.sh ps          列出正在跑的套數
#   scripts/sandbox.sh env 1       印出環境變數，讓既有腳本打這一套：eval "$(scripts/sandbox.sh env 1)"; scripts/smoke.sh
#   scripts/sandbox.sh build       只 build image
#   scripts/sandbox.sh prune       刪掉舊版本的 image，只留最近 3 個（正在跑的不會刪）
#   scripts/sandbox.sh run [情境…] [--parallel 2] [--seed 42] [--only s42-u17-i3] [--repeat 3] [--down]
#                                  跑情境（sandbox/cli.mjs）；沒指定就跑全部 KIND=test 的情境
#   SANDBOX_VIA_BFF=1 scripts/sandbox.sh run …   流量改走 BFF（預設直打 core）：驗 BFF 本身，例如 .env 的 WEB_RUNTIME=next
#   scripts/sandbox.sh list        列出情境
#   scripts/sandbox.sh datadog N core-api,hub｜all｜off [--no-apm]   第 N 套哪些服務送 Datadog（預設全關）
#                                  --no-apm：只送指標和 log、不開 APM trace（壓測用：trace 本身很吃 CPU，會拖慢被測的服務）
#   scripts/sandbox.sh buckets N 8 [SKU…]   第 N 套的庫存分幾桶（熱賣模式；1＝不分；不給 SKU＝所有商品），跑到一半也可以改
#   scripts/sandbox.sh logs <GitHub run id｜資料夾>   用本機 Grafana（port 28000）查 CI 跑出來的 log
#
# port 規則：第 2～3 位是服務、最後兩位是第幾套（1～99）
#   core 210NN、BFF 220NN、hub 230NN、partners 240NN、MySQL 260NN、Redis 270NN、Grafana 280NN
# 日常開發那套（scripts/up.sh、port 13000～18080）完全不受影響
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

# image 用 git commit 標記；有還沒 commit 的修改就加 -dirty（報告上看得出不是乾淨的版本）
tag() {
  local sha; sha=$(git rev-parse --short HEAD)
  if [[ -n "$(git status --porcelain -- services infra)" ]]; then echo "${sha}-dirty"; else echo "$sha"; fi
}

build() {
  local t; t=$(tag)
  echo "== build image（tag ${t}；沒改到的層直接沿用）"
  docker build -q -t demo-core-php:8.3 services/core-api/docker >/dev/null   # core 的基底（開發用的同一個）
  docker build -q -f services/core-api/Dockerfile.sandbox --target php   -t "demo-sandbox/core-api:$t"   services/core-api >/dev/null
  # .env 的 CORE_RUNTIME=go：壓測路徑換成 Go 版（services/core-go），image 名稱不變，K8s 和 dev-container 都用這個
  if [[ "$( (grep -E '^CORE_RUNTIME=' .env 2>/dev/null || true) | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]')" == go ]]; then
    docker build -q -f services/core-go/Dockerfile --build-arg BASE_IMAGE="demo-sandbox/core-api:$t" -t "demo-sandbox/core-api:$t" services/core-go >/dev/null
    echo "   core-api：Go 版（.env 的 CORE_RUNTIME=go）"
  fi
  docker build -q -f services/core-api/Dockerfile.sandbox --target nginx -t "demo-sandbox/core-nginx:$t" services/core-api >/dev/null
  for s in bff-gateway hub partners storefront; do   # storefront 只有 K8s 用（sandbox 的套數不開前台）
    docker build -q -f "services/$s/Dockerfile.sandbox" -t "demo-sandbox/$s:$t" "services/$s" >/dev/null
  done
  # .env 的 WEB_RUNTIME=next：bff-gateway 換成 Next.js 版（services/web-next，同時提供頁面），image 名稱不變
  if [[ "$( (grep -E '^WEB_RUNTIME=' .env 2>/dev/null || true) | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]')" == next ]]; then
    docker build -q -t "demo-sandbox/bff-gateway:$t" services/web-next >/dev/null
    echo "   bff-gateway：Next.js 版（.env 的 WEB_RUNTIME=next）"
  fi
  echo "   完成"
}

# 第 N 套的 project 名稱、port（compose.sandbox.yaml 讀這些變數）
setenv() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] && (( 10#$1 >= 1 && 10#$1 <= 99 )) || { echo "套數要是 1～99" >&2; exit 1; }
  NN=$(printf '%02d' "$((10#$1))")
  export SANDBOX_PROJECT="demo-sb$NN"
  export SANDBOX_TAG="${SANDBOX_TAG:-$(tag)}"
  export CORE_PORT="210$NN" BFF_PORT="220$NN" HUB_PORT="230$NN" PARTNERS_PORT="240$NN"
  export MYSQL_PORT="260$NN" REDIS_PORT="270$NN" GRAFANA_PORT="280$NN"
  export LOG_LEVEL="${LOG_LEVEL:-debug}"
}

# core-api 的執行方式看 image（build 時依 .env 的 CORE_RUNTIME 決定）：Go 版程序內有連線池，直連 MySQL、不開 ProxySQL
db_env() {
  if docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "demo-sandbox/core-api:$SANDBOX_TAG" 2>/dev/null | grep -qx 'CORE_RUNTIME=go'; then
    export SANDBOX_DB_HOST=mysql SANDBOX_DB_PORT=3306 COMPOSE_PROFILES=
  else
    export SANDBOX_DB_HOST=proxysql SANDBOX_DB_PORT=6033 COMPOSE_PROFILES=pool
  fi
}

DD_FILES=()
compose() { docker compose -p "$SANDBOX_PROJECT" -f compose.sandbox.yaml "${DD_FILES[@]+"${DD_FILES[@]}"}" "$@"; }

# ── Datadog 逐服務開關（compose.sandbox.datadog.yaml）：預設全關
DD_SERVICES="core-api core-relay core-worker core-scheduler core-nginx bff-gateway hub partners mysql redis"
dd_selection() {   # 這一套選了哪些服務：SANDBOX_DATADOG（CI 用）優先，否則讀 .sandbox/datadog/demo-sbNN
  local sel="${SANDBOX_DATADOG:-$(cat ".sandbox/datadog/$SANDBOX_PROJECT" 2>/dev/null || true)}"
  [[ "$sel" == "all" ]] && sel=$(tr ' ' ',' <<<"$DD_SERVICES")
  [[ "$sel" == "off" ]] && sel=""
  echo "$sel"
}
dd_env() {
  local sel; sel=$(dd_selection)
  DD_FILES=()
  [[ -z "$sel" ]] && return
  DD_FILES=(-f compose.sandbox.datadog.yaml)
  # 有 kind 叢集：指標也轉發給 K8s 裡的 Prometheus（scripts/k8s.sh metrics）
  SANDBOX_METRICS_HOST=$(docker inspect -f '{{.NetworkSettings.Networks.kind.IPAddress}}' demo-shop-control-plane 2>/dev/null || true)
  if [[ -n "$SANDBOX_METRICS_HOST" ]]; then export SANDBOX_METRICS_HOST; DD_FILES+=(-f compose.sandbox.metrics.yaml); fi
  # API key：CI 從 secrets 傳環境變數；本機讀根目錄 .env（不印出來）
  if [[ -z "${DD_API_KEY:-}" ]]; then
    DD_API_KEY=$(grep -E '^DD_API_KEY=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' ")
    [[ -z "$DD_API_KEY" ]] && { echo "開 Datadog 需要 DD_API_KEY（根目錄 .env）" >&2; exit 1; }
  fi
  export DD_API_KEY
  export DD_SITE="${DD_SITE:-$(grep -E '^DD_SITE=' .env 2>/dev/null | tail -1 | cut -d= -f2- || echo ap1.datadoghq.com)}"
  export DD_ENV_NAME="${DD_ENV_NAME:-sandbox-$NN}"
  local logs="" svc var apm=true
  [[ "$(cat ".sandbox/datadog/$SANDBOX_PROJECT.apm" 2>/dev/null || true)" == "off" || "${SANDBOX_DD_APM:-}" == "off" ]] && apm=false
  for svc in ${sel//,/ }; do
    [[ " $DD_SERVICES " == *" $svc "* ]] || { echo "不認識的服務：${svc}（可以用：${DD_SERVICES}）" >&2; exit 1; }
    var=$(tr '[:lower:]-' '[:upper:]_' <<<"$svc")
    export "DDT_$var=$apm" "DDH_$var=datadog-agent"
    logs+="name:^$SANDBOX_PROJECT-$svc-1\$ "
  done
  [[ ",$sel," == *",mysql,"* ]] && export DDC_MYSQL='{"mysql": {"instances": [{"host": "%%host%%", "port": 3306, "username": "root", "password": "root"}]}}'
  [[ ",$sel," == *",redis,"* ]] && export DDC_REDIS='{"redisdb": {"instances": [{"host": "%%host%%", "port": 6379}]}}'
  export DD_LOGS_INCLUDE="${logs% }"
}

# scripts/sandbox.sh datadog N core-api,hub｜all｜off：存下選擇，再 up 一次套用（沒勾的服務 trace、log、指標都不送）
datadog() {
  setenv "${1:-}"
  local sel="${2:-}" apm=on
  [[ "${3:-}" == "--no-apm" ]] && apm=off
  [[ -z "$sel" ]] && { echo "目前：$(dd_selection || true)（APM $(cat ".sandbox/datadog/$SANDBOX_PROJECT.apm" 2>/dev/null || echo on)）"; echo "用法：scripts/sandbox.sh datadog N core-api,hub｜all｜off [--no-apm]"; exit 0; }
  mkdir -p .sandbox/datadog
  echo "$sel" > ".sandbox/datadog/$SANDBOX_PROJECT"
  echo "$apm" > ".sandbox/datadog/$SANDBOX_PROJECT.apm"
  echo "== $SANDBOX_PROJECT 的 Datadog：${sel}（APM ${apm}）"
  up "$1"   # 會先 build：程式改過的話，image 的版本要跟著換（有快取，沒改的部分幾秒就好）
}

# 同一套同時間只能有一個操作（啟動、刪除、跑情境）：兩個 compose 同時重建同一個容器會撞名
#   .sandbox/locks/demo-sbNN/pid 記著是誰在用；那個程序已經不在了就直接接手
#   sandbox/cli.mjs 跑情境時整段都持有鎖，它自己呼叫這支腳本時用 SANDBOX_LOCK_HELD 告知，不用再搶
lock() {
  [[ "${SANDBOX_LOCK_HELD:-}" == "$SANDBOX_PROJECT" ]] && return
  local dir=".sandbox/locks/$SANDBOX_PROJECT" waited=0
  mkdir -p .sandbox/locks
  until mkdir "$dir" 2>/dev/null; do
    local owner; owner=$(cat "$dir/pid" 2>/dev/null || true)
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$dir"; continue; fi
    (( waited == 0 )) && echo "== $SANDBOX_PROJECT 正在被其他操作使用（$(cat "$dir/what" 2>/dev/null || echo '?')），等它結束…"
    (( waited++ > 1800 )) && { echo "等太久了（30 分鐘）" >&2; exit 1; }
    sleep 1
  done
  echo $$ > "$dir/pid"; echo "$1" > "$dir/what"
  trap 'rm -rf "'"$dir"'"' EXIT
}

# APP_KEY：每套固定一把（第一次啟動時產生、存在 .sandbox/，down 時刪掉）
# 每次都產生新的會讓 core 每次 up 都被重建：慢，而且容易和其他操作撞名
app_key() {
  local f=".sandbox/keys/$SANDBOX_PROJECT"
  mkdir -p .sandbox/keys
  [[ -s "$f" ]] || echo "base64:$(openssl rand -base64 32)" > "$f"
  cat "$f"
}

up() {
  local n=${1:-}; shift || true
  setenv "$n"
  lock "啟動"
  # --no-build 但這個版本的 image 還不存在（剛 commit 完 tag 換了）→ 還是要 build
  if [[ "${1:-}" != "--no-build" ]] || ! docker image inspect "demo-sandbox/core-api:$SANDBOX_TAG" >/dev/null 2>&1; then build; fi
  export SANDBOX_APP_KEY; SANDBOX_APP_KEY=$(app_key)
  dd_env
  db_env
  echo "== 啟動 ${SANDBOX_PROJECT}（image ${SANDBOX_TAG}；core → ${SANDBOX_DB_HOST}）"
  local log; log=$(mktemp)
  compose up -d --remove-orphans --quiet-pull >"$log" 2>&1 || { cat "$log" >&2; exit 1; }
  # 從 FPM 換成 Go：之前開的 ProxySQL 不在 profile 裡，compose 不會自己收
  [[ -z "$COMPOSE_PROFILES" ]] && docker rm -f "$SANDBOX_PROJECT-proxysql-1" >/dev/null 2>&1 || true

  # 等到真的能用：core-init（建資料表、灌資料）跑完、core 和 hub 都回應
  for _ in $(seq 1 90); do
    curl -sf "localhost:$CORE_PORT/up" >/dev/null && curl -sf "localhost:$HUB_PORT/health" >/dev/null && break
    if compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' | grep -E '^core-init exited [1-9]' >/dev/null; then
      echo "core-init 失敗：" >&2; compose logs core-init | tail -20 >&2; exit 1
    fi
    sleep 2
  done
  curl -sf "localhost:$CORE_PORT/up" >/dev/null || { echo "$SANDBOX_PROJECT 啟動逾時" >&2; exit 1; }

  echo
  echo "  $SANDBOX_PROJECT 就緒"
  echo "  core API    http://localhost:$CORE_PORT/api/v1"
  echo "  BFF         http://localhost:$BFF_PORT"
  echo "  hub         http://localhost:$HUB_PORT"
  echo "  廠商控制台  http://localhost:$PARTNERS_PORT"
  echo "  debug log   http://localhost:$GRAFANA_PORT"
  echo "  MySQL       localhost:${MYSQL_PORT}（demo／demo）   Redis localhost:$REDIS_PORT   core 連 ${SANDBOX_DB_HOST}"
  local sel; sel=$(dd_selection)
  echo "  Datadog     ${sel:-關閉}${sel:+（env:${DD_ENV_NAME}）}"
}

down() {
  setenv "${1:-}"
  lock "刪除"
  echo "== 刪除 ${SANDBOX_PROJECT}（container、網路、volume）"
  COMPOSE_PROFILES=pool compose down -v --remove-orphans 2>&1 | grep -E 'Error|error' || true
  rm -f ".sandbox/keys/$SANDBOX_PROJECT" ".sandbox/datadog/$SANDBOX_PROJECT" ".sandbox/datadog/$SANDBOX_PROJECT.apm"
  echo "   完成"
}

ps_all() {
  local p
  p=$(docker ps --format '{{.Label "com.docker.compose.project"}}' | grep -E '^demo-sb[0-9]{2}$' | sort -u || true)
  [[ -z "$p" ]] && { echo "沒有正在跑的 sandbox 套數"; return; }
  for x in $p; do
    printf '%s  %s 個 container  core http://localhost:210%s\n' "$x" "$(docker ps -q --filter "label=com.docker.compose.project=$x" | wc -l | tr -d ' ')" "${x#demo-sb}"
  done
}

print_env() {
  setenv "${1:-}"
  cat <<EOF
export CORE_URL=http://localhost:$CORE_PORT MOCK_URL=http://localhost:$PARTNERS_PORT HUB_URL=http://localhost:$HUB_PORT
export COMPOSE_PROJECT_NAME=$SANDBOX_PROJECT COMPOSE_FILE=compose.sandbox.yaml SANDBOX_TAG=$SANDBOX_TAG
EOF
}

# image 會一直累積（每個 commit 一組）：只留最近 3 個版本；正在被容器使用的 docker 會拒絕刪除，直接略過
prune() {
  local old; old=$(docker images demo-sandbox/core-api --format '{{.Tag}}' | tail -n +4)
  [[ -z "$old" ]] && { echo "沒有要清的舊版本"; return; }
  for t in $old; do
    for s in core-api core-nginx bff-gateway hub partners; do docker rmi "demo-sandbox/$s:$t" >/dev/null 2>&1 || true; done
    echo "  刪除 $t"
  done
  docker image prune -f >/dev/null   # 沒有名字的中間層
}

# 庫存分桶：改「想要幾桶」，馬上拆／併好（core-scheduler 本來就會每 5 秒收斂，這裡不等它）
buckets() {
  local n=${1:-} target=${2:-}
  [[ -n "$n" && "$target" =~ ^[0-9]+$ ]] || usage
  shift 2
  setenv "$n"
  compose exec -T core-api php artisan inventory:buckets "$target" "$@" --now
}

case "${1:-}" in
  up)    shift; up "$@" ;;
  down)  shift; down "$@" ;;
  ps)    ps_all ;;
  env)   shift; print_env "$@" ;;
  build) build ;;
  tag)   tag ;;
  datadog) shift; datadog "$@" ;;
  buckets) shift; buckets "$@" ;;
  run|list|logs) exec node sandbox/cli.mjs "$@" ;;
  prune) prune ;;
  *)     usage ;;
esac
