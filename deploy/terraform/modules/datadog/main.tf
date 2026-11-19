# Datadog Agent（官方 Helm chart）：每個 Node 一個，收 APM trace、DogStatsD 指標、log
# 只收 demo-shop namespace 的容器（M12 的教訓：不要把同一台機器上其他東西送出去）
# API key 由 scripts/bootstrap.sh 從根目錄 .env 讀進來（TF_VAR_datadog_api_key），不寫在任何檔案裡
terraform {
  required_providers {
    helm = { source = "hashicorp/helm" }
  }
}

variable "api_key" {
  type      = string
  sensitive = true
}
variable "site" { type = string }
variable "cluster_name" { type = string }
variable "app_namespace" { type = string }
variable "env" {
  type    = string
  default = "k8s"
}

resource "helm_release" "this" {
  name             = "datadog"
  repository       = "https://helm.datadoghq.com"
  chart            = "datadog"
  version          = "3.245.2"
  namespace        = "datadog"
  create_namespace = true
  atomic           = true

  values = [yamlencode({
    datadog = {
      site        = var.site
      clusterName = var.cluster_name
      tags        = ["env:${var.env}"]
      kubelet     = { tlsVerify = false }                          # kind 的 kubelet 憑證是自簽的（只限本機）
      apm         = { portEnabled = true }                         # hostPort 8126：Pod 用 status.hostIP 連所在 Node 的 Agent
      dogstatsd   = { useHostPort = true, nonLocalTraffic = true } # hostPort 8125（UDP）
      logs        = { enabled = true, containerCollectAll = true }
      # 先排除全部，再只收 demo-shop（K8s 本身、Traefik、KEDA、log 系統都不收）
      containerExclude = "kube_namespace:.*"
      containerInclude = "kube_namespace:${var.app_namespace}"
      processAgent     = { enabled = false }
      env = [
        { name = "DD_APM_IGNORE_RESOURCES", value = "GET /fpm-status,GET /fpm-ping,GET /health,GET /up" },
        # 自訂指標多轉發一份給 statsd_exporter（scripts/k8s.sh metrics）：沒裝的話 UDP 送不到，不影響 Datadog
        { name = "DD_STATSD_FORWARD_HOST", value = "statsd-exporter.monitoring.svc.cluster.local" },
        { name = "DD_STATSD_FORWARD_PORT", value = "9125" },
      ]
    }
  })]

  set_sensitive = [{ name = "datadog.apiKey", value = var.api_key }]
}
