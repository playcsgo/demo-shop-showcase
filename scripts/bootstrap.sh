#!/usr/bin/env bash
# 一個指令開起整套環境：git clone 之後直接跑這個
#
#   scripts/bootstrap.sh          開起全部（第一次約 10 分鐘，之後只改有變的部分）
#   scripts/bootstrap.sh plan     只看 Terraform 打算改什麼，不動手
#   scripts/bootstrap.sh down     全部關掉、刪乾淨
#
# Datadog：根目錄 .env 的 DATA_DOG=TRUE 時，K8s 也裝 Datadog Agent、各服務打開 trace（API key 讀 .env 的 DD_API_KEY）
#
# 做的事：
#   1. 檢查工具（Docker、kind、kubectl、Terraform、node）
#   2. build image（build 不是 Terraform 的工作，先在這裡做好）
#   3. terraform apply（deploy/terraform/local）：kind 叢集 → Traefik、metrics-server、KEDA → LocalStack → 佇列
#      → log 系統（Alloy、Loki、Grafana）→ 應用程式
#   4. sandbox：第 1 套環境（docker compose）＋ sandbox UI（含叢集地圖）
set -euo pipefail
cd "$(dirname "$0")/.."

TF_DIR=deploy/terraform/local
CLUSTER=demo-shop
UI_PID=.sandbox/ui.pid
UI_LOG=.sandbox/ui.log
UI_URL=http://localhost:25000

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
tf() { terraform -chdir="$TF_DIR" "$@"; }

check_tools() {
  local missing=()
  for t in docker kind kubectl terraform node git curl; do command -v "$t" >/dev/null || missing+=("$t"); done
  if ((${#missing[@]})); then
    echo "缺少工具：${missing[*]}" >&2
    echo "  macOS：brew install kind kubectl node && brew tap hashicorp/tap && brew install hashicorp/tap/terraform" >&2
    echo "  Docker：安裝 OrbStack 或 Docker Desktop" >&2
    exit 1
  fi
  docker info >/dev/null 2>&1 || { echo "Docker 沒有在跑：先開 OrbStack 或 Docker Desktop" >&2; exit 1; }
}

# K8s 用的 tag 要跟著 image 內容變：沒 commit 的修改 tag 都是 <commit>-dirty，同一個 tag K8s 會以為沒變、不會換 Pod
image_tag() {
  local base ids
  base=$(scripts/sandbox.sh tag)
  ids=$(for s in core-api core-nginx bff-gateway hub partners storefront; do docker image inspect -f '{{.Id}}' "demo-sandbox/$s:$base"; done)
  echo "$base-$(shasum <<<"$ids" | cut -c1-8)"
}

build_images() {
  scripts/sandbox.sh build
  local base tag; base=$(scripts/sandbox.sh tag); tag=$(image_tag)
  for s in core-api core-nginx bff-gateway hub partners storefront; do docker tag "demo-sandbox/$s:$base" "demo-sandbox/$s:$tag"; done
  echo "$tag" > .sandbox/k8s-image-tag
}

# 叢集已經存在、但不是這份 Terraform 建的（例如以前用 scripts/k8s.sh up 建的）：不自動刪，請使用者決定
check_existing_cluster() {
  # 不用 grep -q：它一找到就結束，前面的指令被中斷（SIGPIPE），pipefail 會把整條當成失敗 → 誤判成「不是 Terraform 建的」（實際踩到）
  local state; state=$(tf state list 2>/dev/null || true)
  if kind get clusters 2>/dev/null | grep -x "$CLUSTER" >/dev/null && ! grep -x 'module.cluster.kind_cluster.this' <<<"$state" >/dev/null; then
    echo "已經有一個叫 $CLUSTER 的 kind 叢集，但不是這份 Terraform 建的。" >&2
    echo "要改由 Terraform 管理，先刪掉它：kind delete cluster --name $CLUSTER" >&2
    exit 1
  fi
}

start_ui() {
  if curl -sf "$UI_URL/api/state" >/dev/null 2>&1; then echo "   sandbox UI 已經在跑"; return; fi
  nohup node sandbox/server.mjs >"$UI_LOG" 2>&1 &
  echo $! >"$UI_PID"
  for _ in $(seq 1 20); do curl -sf "$UI_URL/api/state" >/dev/null 2>&1 && return; sleep 0.5; done
  echo "sandbox UI 沒有起來，看 $UI_LOG" >&2; exit 1
}

stop_ui() {
  if [[ -f $UI_PID ]] && kill "$(cat "$UI_PID")" 2>/dev/null; then echo "== 停止 sandbox UI"; fi
  rm -f "$UI_PID"
}

# Datadog 的開關和金鑰從根目錄 .env 讀（不印出來、不寫進任何檔案；交給 Terraform 的 sensitive 變數）
datadog_env() {
  local on key site apm
  on=$(grep -E '^DATA_DOG=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr '[:lower:]' '[:upper:]')
  if [[ "$on" == "TRUE" ]]; then
    key=$(grep -E '^DD_API_KEY=' .env | cut -d= -f2- | tr -d '"')
    site=$(grep -E '^DD_SITE=' .env | cut -d= -f2- | tr -d '"')
    [[ -n "$key" ]] || { echo ".env 的 DATA_DOG=TRUE，但沒有 DD_API_KEY" >&2; exit 1; }
    # DATA_DOG_APM=FALSE：只送指標和 log、不開 APM trace（壓測用）；沒寫就是開
    apm=$(grep -E '^DATA_DOG_APM=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]')
    [[ "$apm" == "false" ]] || apm=true
    export TF_VAR_datadog_api_key="$key" TF_VAR_datadog_site="${site:-ap1.datadoghq.com}" TF_VAR_datadog_apm="$apm"
    echo "   Datadog：開（site ${site:-ap1.datadoghq.com}、APM ${apm}）"
  else
    export TF_VAR_datadog_api_key=""
    echo "   Datadog：關（.env 的 DATA_DOG）"
  fi
}

# core-api 的 PHP 執行方式：.env 的 CORE_RUNTIME（fpm／octane，沒寫就是 fpm）；scripts/k8s.sh runtime 會改這一行
runtime_env() {
  local rt
  rt=$( (grep -E '^CORE_RUNTIME=' .env 2>/dev/null || true) | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]')
  rt=${rt:-fpm}
  [[ "$rt" == fpm || "$rt" == octane || "$rt" == go ]] || { echo ".env 的 CORE_RUNTIME 只能是 fpm、octane 或 go：$rt" >&2; exit 1; }
  export TF_VAR_core_runtime="$rt"
  echo "   core-api：${rt}（.env 的 CORE_RUNTIME）"
  # 前台＋BFF：nest（預設）／next（Next.js，services/web-next）；scripts/k8s.sh web 會改這一行
  local web
  web=$( (grep -E '^WEB_RUNTIME=' .env 2>/dev/null || true) | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]')
  web=${web:-nest}
  [[ "$web" == nest || "$web" == next ]] || { echo ".env 的 WEB_RUNTIME 只能是 nest 或 next：$web" >&2; exit 1; }
  export TF_VAR_web_runtime="$web"
  echo "   前台＋BFF：${web}（.env 的 WEB_RUNTIME）"
}

up() {
  local started=$SECONDS
  echo "== 檢查工具"; check_tools
  mkdir -p .sandbox
  check_existing_cluster
  build_images
  local tag; tag=$(cat .sandbox/k8s-image-tag)

  echo "== Terraform（image tag ${tag}）"
  datadog_env
  runtime_env
  tf init -input=false >/dev/null
  tf apply -input=false -auto-approve -var "image_tag=$tag"

  echo "== sandbox：第 1 套環境＋UI"
  scripts/sandbox.sh up 1 --no-build
  start_ui

  local m=$(((SECONDS - started) / 60)) s=$(((SECONDS - started) % 60))
  cat <<EOF

完成（${m} 分 ${s} 秒）
  K8s（kind 叢集 ${CLUSTER}，kubectl --context kind-${CLUSTER}）
    前台          http://localhost:8088
    後台          http://core.localhost:8088/admin
    廠商控制台    http://partners.localhost:8088
    log（Grafana）http://grafana.localhost:8088
    K8s 網頁介面  http://headlamp.localhost:8088（Headlamp，唯讀）
  sandbox
    UI＋叢集地圖  $UI_URL
    第 1 套       core port 21001、Grafana port 28001（scripts/sandbox.sh ps）
  壓力測試        scripts/k8s.sh load
  全部關掉        scripts/bootstrap.sh down
EOF
}

plan() {
  check_tools
  [[ -f .sandbox/k8s-image-tag ]] || { echo "還沒 build 過：先跑 scripts/bootstrap.sh" >&2; exit 1; }
  datadog_env
  runtime_env
  tf init -input=false >/dev/null
  tf plan -input=false -var "image_tag=$(cat .sandbox/k8s-image-tag)"
}

down() {
  stop_ui
  echo "== sandbox 第 1 套"; scripts/sandbox.sh down 1 || true
  # 不用 terraform destroy：它會先透過 K8s API 一個一個刪 Helm release、Secret…，最後才刪叢集，
  # 又慢又可能卡在 KEDA 的 finalizer。本機的東西全都在叢集裡（連 LocalStack 的佇列也是），刪叢集就全部沒了
  echo "== 刪除 kind 叢集"
  kind delete cluster --name "$CLUSTER" 2>/dev/null || true
  # state 記的資源都跟著叢集消失了，一起清掉（密鑰也是，下次重新產生）
  rm -f "$TF_DIR/terraform.tfstate" "$TF_DIR/terraform.tfstate.backup"
  echo "完成"
}

case "${1:-up}" in
  up) up ;;
  plan) plan ;;
  down) down ;;
  *) usage ;;
esac
