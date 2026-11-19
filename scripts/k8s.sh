#!/usr/bin/env bash
# 本機 K8s（kind：1 個控制節點＋3 個工作節點，跑在 OrbStack 上）
#
# 建立和刪除改由 Terraform 負責：scripts/bootstrap.sh（開起全部）、scripts/bootstrap.sh down（全部刪掉）
#
#   scripts/k8s.sh status    Node、Pod 分佈、自動擴充的狀況
#   scripts/k8s.sh load      在叢集裡跑 k6 壓力測試（真實世界設定），看 HPA／KEDA 自動擴充
#                              STAGES=10:1m,40:2m（每秒下單數:多久）　PARTNER_SETTINGS='{"payment":{"latencyMs":1500}}'（金流變慢）
#                              PRESET=perfect（完美世界；預設 realistic 真實世界）
#   scripts/k8s.sh stress    找上限：查詢、下單分開一階一階往上加，看在哪一階開始變慢或出錯（廠商預設完美世界）
#                              READ_LEVELS=200,500,1000（每秒查詢）　ORDER_LEVELS=20,40,80（每秒下單）　RAMP=15s HOLD=40s
#                              BUCKETS=8（開跑前把庫存分成幾桶；load 也可以用）
#   scripts/k8s.sh buckets 8 [SKU…]   庫存分幾桶（熱賣模式；1＝不分；不給 SKU＝所有商品）。壓測跑到一半也可以改
#   scripts/k8s.sh buckets           只看現在每個商品幾桶
#   scripts/k8s.sh runtime octane    core-api 改跑 Octane（fpm 換回 PHP-FPM、go 換成 Go 版）：改 .env 的 CORE_RUNTIME 再重新部署（scripts/bootstrap.sh）
#   scripts/k8s.sh runtime           只看現在部署的是哪一種、.env 寫的是哪一種
#   scripts/k8s.sh web next          前台＋BFF 換成 Next.js 版（nest 換回 NestJS＋Vite）；不帶參數只看現在是哪一版
#   scripts/k8s.sh metrics   裝 Prometheus、Grafana、statsd_exporter 和服務效能看板（Datadog Agent 多轉發一份指標過來）
#   scripts/k8s.sh metrics-check [k8s|sandbox-01]   確認七站的處理時間和每個服務的 CPU 都有數據；缺一項就失敗（要先送過下單流量）
#
# 入口：http://localhost:8088（前台）、http://core.localhost:8088/admin（後台）、http://partners.localhost:8088（廠商控制台）
#       http://metrics.localhost:8088（服務效能看板）
# 看 Pod 分佈：sandbox UI 的「叢集地圖」（node sandbox/server.mjs → http://localhost:25000）
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=demo-shop
NS=demo-shop
CTX="kind-$CLUSTER"
k() { kubectl --context "$CTX" "$@"; }
usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

status() {
  echo "== Node"; k get nodes -o wide | awk '{printf "%-28s %-8s %-14s\n", $1, $2, $3}'
  echo; echo "== 每個 Node 上的 Pod"
  k -n "$NS" get pods -o wide --no-headers | awk '{n[$7]=n[$7]" "$1} END{for(k in n) print k ":" n[k]}' | sort
  echo; echo "== 自動擴充（HPA：core-api、bff 看 CPU；keda-hpa-*：hub 各廠商看佇列長度）"
  k -n "$NS" get hpa
}

# 廠商設定：PRESET（預設見各指令）＋PARTNER_SETTINGS 覆寫，例如金流變慢 → 只有 hub-payment 會擴充
partners_preset() {
  echo "== 廠商設定：$1${PARTNER_SETTINGS:+，再加上 $PARTNER_SETTINGS}"
  k -n "$NS" exec deploy/partners -- node -e "
    const call = async (m, p, b) => {
      const r = await fetch('http://127.0.0.1:4000' + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) });
      if (!r.ok) throw new Error(m + ' ' + p + ' → ' + r.status + ' ' + await r.text());
    };
    (async () => { await call('POST', '/admin/presets/' + process.argv[1]); if (process.argv[2]) await call('PUT', '/admin/settings', JSON.parse(process.argv[2])); })()
      .catch((e) => { console.error('廠商設定失敗（不跑了，免得用錯的世界壓測）：' + e.message); process.exit(1); });
  " "$1" "${PARTNER_SETTINGS:-}" >/dev/null
}

# 在叢集裡跑 k6（K8s Job）：run_k6 <腳本> <環境變數 NAME=VALUE…>
run_k6() {
  local script=$1; shift
  local env="" kv
  for kv in "$@"; do env+="            - { name: ${kv%%=*}, value: \"${kv#*=}\" }"$'\n'; done
  k -n "$NS" create configmap k6-scripts --from-file=shop.js=sandbox/k6/shop.js \
    --from-file=k8s-load.js=deploy/k6/k8s-load.js --from-file=k8s-stress.js=deploy/k6/k8s-stress.js \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  k -n "$NS" delete job k6-load --ignore-not-found >/dev/null
  cat <<EOF | k apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata: { name: k6-load, namespace: $NS }
spec:
  backoffLimit: 0
  template:
    metadata: { labels: { demo/service: k6 } }
    spec:
      restartPolicy: Never
      containers:
        - name: k6
          image: grafana/k6:2.3.0
          imagePullPolicy: IfNotPresent
          args: ["run", "--quiet", "/scripts/$script"]
          env:
            # 走入口（Traefik），不直接打 core 的 Service：Service 是「建立連線時」才分配 Pod，
            # k6 的長連線一開始就黏在最早的 2 個 Pod 上，HPA 擴充出來的 Pod 完全分不到流量（實際踩到）
            - { name: BASE, value: "http://traefik.traefik.svc.cluster.local/api/v1" }
            - { name: HOST, value: "core.localhost" }
            # 每次用新的 seed：結帳的冪等鍵由 seed 產生，用同一個 seed 會被當成重複結帳、直接回傳上次的訂單（實際踩到）
            - { name: SEED, value: "${SEED:-$(date +%s)}" }
$env          volumeMounts:
            - { name: scripts, mountPath: /scripts }
      volumes:
        - name: scripts
          configMap: { name: k6-scripts }
EOF
  k -n "$NS" wait --for=condition=Ready pod -l job-name=k6-load --timeout=120s >/dev/null
  k -n "$NS" logs -f job/k6-load
}

# 庫存分桶：改「想要幾桶」並馬上拆／併好（core-scheduler 本來就會每 5 秒收斂，這裡不等它）
buckets() {
  if (($# == 0)); then k -n "$NS" exec deploy/core-api -c php -- php artisan inventory:buckets --status; return; fi
  [[ "$1" =~ ^[0-9]+$ ]] || usage
  echo "== 庫存分桶：$1 桶${2:+（$*）}"
  k -n "$NS" exec deploy/core-api -c php -- php artisan inventory:buckets "$@" --now
}

# 壓力測試：每秒下單數依 STAGES 逐步變化（STAGES＝每秒下單數:維持多久），廠商預設「真實世界」
load() {
  local stages="${STAGES:-10:1m,40:2m,80:2m,0:1m}"
  partners_preset "${PRESET:-realistic}"
  if [[ -n "${BUCKETS:-}" ]]; then buckets "$BUCKETS"; fi
  echo "== k6 開始（${stages}）。看擴充：sandbox UI 的「叢集地圖」，或另開終端機 watch scripts/k8s.sh status"
  run_k6 k8s-load.js "STAGES=$stages"
}

# 找上限：查詢、下單分開，一階一階往上加；廠商預設「完美世界」（量的是 core 和資料庫，不受廠商延遲影響）
stress() {
  partners_preset "${PRESET:-perfect}"
  if [[ -n "${BUCKETS:-}" ]]; then buckets "$BUCKETS"; fi
  echo "== k6 找上限：查詢 ${READ_LEVELS:-（不打）}／下單 ${ORDER_LEVELS:-（不打）}，每階爬升 ${RAMP:-15s}、維持 ${HOLD:-40s}"
  run_k6 k8s-stress.js "READ_LEVELS=${READ_LEVELS:-}" "ORDER_LEVELS=${ORDER_LEVELS:-}" "RAMP=${RAMP:-15s}" "HOLD=${HOLD:-40s}"
}

# core-api 的 PHP 執行方式（fpm／octane）。寫進 .env 的 CORE_RUNTIME 再跑 bootstrap：
# 不直接 helm upgrade，不然下一次 bootstrap（Terraform）又會改回 .env 寫的那一種
runtime() {
  local want="${1:-}" deployed configured
  deployed=$(k -n "$NS" get deploy core-api -o jsonpath='{.spec.template.spec.containers[?(@.name=="php")].env[?(@.name=="CORE_RUNTIME")].value}' 2>/dev/null)
  [[ -n "$deployed" ]] || deployed=$(k -n "$NS" get deploy core-api -o jsonpath='{.spec.template.spec.containers[?(@.name=="php")].command}' 2>/dev/null | grep -q 'octane:start' && echo octane || echo fpm)
  configured=$( (grep -E '^CORE_RUNTIME=' .env 2>/dev/null || true) | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]')
  configured=${configured:-fpm}
  if [[ -z "$want" ]]; then echo "部署中：${deployed}　.env：$configured"; return; fi
  [[ "$want" == fpm || "$want" == octane || "$want" == go ]] || { echo "只能是 fpm、octane 或 go：$want" >&2; exit 1; }
  if [[ -f .env ]] && grep -qE '^CORE_RUNTIME=' .env; then
    sed -i.bak -E "s/^CORE_RUNTIME=.*/CORE_RUNTIME=$want/" .env && rm -f .env.bak
  else
    printf '\nCORE_RUNTIME=%s\n' "$want" >> .env
  fi
  echo "== .env：CORE_RUNTIME=$want"
  if [[ "$deployed" == "$want" ]]; then echo "   已經是 ${want}，不用重新部署"; return; fi
  echo "== 重新部署（scripts/bootstrap.sh）"
  scripts/bootstrap.sh
}

# 前台＋BFF 用哪一版（nest／next）。和 runtime 同一個做法：寫進 .env 的 WEB_RUNTIME 再跑 bootstrap
web() {
  local want="${1:-}" deployed configured
  deployed=$(k -n "$NS" get deploy bff -o jsonpath='{.spec.template.spec.containers[?(@.name=="bff")].env[?(@.name=="WEB_RUNTIME")].value}' 2>/dev/null)
  deployed=${deployed:-nest}
  configured=$( (grep -E '^WEB_RUNTIME=' .env 2>/dev/null || true) | cut -d= -f2- | tr -d '"' | tr '[:upper:]' '[:lower:]')
  configured=${configured:-nest}
  if [[ -z "$want" ]]; then echo "部署中：${deployed}　.env：$configured"; return; fi
  [[ "$want" == nest || "$want" == next ]] || { echo "只能是 nest 或 next：$want" >&2; exit 1; }
  if [[ -f .env ]] && grep -qE '^WEB_RUNTIME=' .env; then
    sed -i.bak -E "s/^WEB_RUNTIME=.*/WEB_RUNTIME=$want/" .env && rm -f .env.bak
  else
    printf '\nWEB_RUNTIME=%s\n' "$want" >> .env
  fi
  echo "== .env：WEB_RUNTIME=$want"
  if [[ "$deployed" == "$want" ]]; then echo "   已經是 ${want}，不用重新部署"; return; fi
  echo "== 重新部署（scripts/bootstrap.sh）"
  scripts/bootstrap.sh
}

metrics() {
  local obs=monitoring dir=deploy/observability
  k create namespace "$obs" --dry-run=client -o yaml | k apply -f - >/dev/null
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update prometheus-community >/dev/null

  echo "== 看板（grafana_dashboard 標籤：Grafana 的 sidecar 會自動載入）"
  k -n "$obs" create configmap service-performance-dashboard --from-file=service-performance.json="$dir/service-performance.json" --dry-run=client -o yaml \
    | k label --local -f - grafana_dashboard=1 -o yaml | k apply -f - >/dev/null
  k -n "$obs" apply -f "$dir/loki-datasources.yaml" >/dev/null   # 錯誤看板查 log 用
  k -n "$obs" create configmap error-dashboards --from-file="$dir/errors-k8s.json" --from-file="$dir/errors-dev-container.json" --dry-run=client -o yaml \
    | k label --local -f - grafana_dashboard=1 -o yaml | k apply -f - >/dev/null

  echo "== Prometheus＋Grafana"
  # 釘在 91.5.0（operator v0.94.0）：更新的版本帶的 operator 沒有 arm64 image，Mac 上拉不下來
  helm upgrade --install metrics prometheus-community/kube-prometheus-stack --kube-context "$CTX" -n "$obs" --version 91.5.0 \
    -f "$dir/kube-prometheus-stack.yaml" --wait --timeout 8m >/dev/null

  echo "== statsd_exporter"
  k -n "$obs" apply -f "$dir/statsd-exporter.yaml" >/dev/null
  k -n "$obs" rollout status deploy/statsd-exporter --timeout 120s >/dev/null

  echo "== sandbox 容器的 CPU（demo-docker-cpu）"
  docker rm -f demo-docker-cpu >/dev/null 2>&1 || true
  docker run -d --name demo-docker-cpu --network kind --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock:ro -v "$PWD/$dir/docker-cpu-exporter.mjs:/exporter.mjs:ro" \
    node:22-alpine node /exporter.mjs >/dev/null

  echo "== Datadog Agent 多轉發一份指標（Terraform 的 datadog 模組有同樣的設定，重新部署不會蓋掉）"
  k -n datadog set env daemonset/datadog -c agent \
    DD_STATSD_FORWARD_HOST="statsd-exporter.$obs.svc.cluster.local" DD_STATSD_FORWARD_PORT=9125 >/dev/null
  k -n datadog rollout status daemonset/datadog --timeout 300s >/dev/null
  echo "完成：http://metrics.localhost:8088"
}

prom_query() {   # Prometheus 的 image 沒有 wget／curl，走 K8s API 的 proxy
  k get --raw "/api/v1/namespaces/monitoring/services/metrics-kube-prometheus-st-prometheus:9090/proxy/api/v1/query?query=$(jq -rn --arg q "$1" '$q|@uri')"
}
prom_count() { prom_query "$1" | jq '.data.result | length'; }

metrics_check() {
  local env="${1:-k8s}" stations services k6
  stations=$(prom_count "count by (station) (demo_pipeline_handle_ms_count{station!=\"\", env=\"$env\"})")
  services=$(prom_count "sum by (app_service) (rate(container_cpu_usage_seconds_total{env=\"$env\"}[1m]))")
  [[ "$stations" == 7 ]] && echo "  ✅ $env：七站都有處理時間" || { echo "  ❌ $env：只有 $stations 站有處理時間（要 7 站，先送下單流量）"; return 1; }
  [[ "$services" -gt 0 ]] && echo "  ✅ $env：$services 個服務有 CPU" || { echo "  ❌ $env：沒有 CPU 數據"; return 1; }
  k6=$(prom_count "count(k6_http_reqs_total{step=\"checkout\", env=\"$env\"})")
  [[ "$k6" -gt 0 ]] && echo "  ✅ $env：有 k6 的結帳計數" || { echo "  ❌ $env：沒有 k6 的結帳計數（要用 loadtest/run.mjs 跑過一輪）"; return 1; }
}

case "${1:-}" in
  status) status ;;
  metrics) metrics ;;
  metrics-check) shift; metrics_check "$@" ;;
  load) load ;;
  stress) stress ;;
  buckets) shift; buckets "$@" ;;
  runtime) shift; runtime "$@" ;;
  web) shift; web "$@" ;;
  *) usage ;;
esac
