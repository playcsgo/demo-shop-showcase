# 叢集的外掛元件：Traefik（入口）、metrics-server（HPA 要的 CPU 數據）、KEDA（依佇列長度擴充）
# 版本和設定檔與原本的 scripts/k8s.sh 相同（deploy/addons/*.yaml）
# atomic：安裝失敗就自動移除，否則留下一個「失敗」狀態的 release，下次 apply 會撞名（實際踩到）
terraform {
  required_providers {
    helm = { source = "hashicorp/helm" }
  }
}

variable "addons_dir" {
  description = "deploy/addons 的路徑"
  type        = string
}

resource "helm_release" "traefik" {
  name             = "traefik"
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = "41.7.0"
  namespace        = "traefik"
  create_namespace = true
  values           = [file("${var.addons_dir}/traefik-values.yaml")]
  atomic           = true
}

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.14.0"
  namespace  = "kube-system"
  values     = [file("${var.addons_dir}/metrics-server-values.yaml")]
  atomic     = true
}

resource "helm_release" "keda" {
  name             = "keda"
  repository       = "https://kedacore.github.io/charts"
  chart            = "keda"
  version          = "2.21.0"
  namespace        = "keda"
  create_namespace = true
  atomic           = true
}

# 給其他模組 depends_on 用：入口和 KEDA 的 CRD 都裝好了
output "ready" {
  value = [helm_release.traefik.id, helm_release.metrics_server.id, helm_release.keda.id]
}
