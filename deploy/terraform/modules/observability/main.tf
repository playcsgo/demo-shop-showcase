# K8s 裡的 debug log：Alloy → Loki → Grafana（deploy/helm/observability）
# 設定檔直接讀 repo 裡的檔案，和 docker compose 同一份：Loki、dashboard 共用；Alloy 只有「去哪裡找 log」不同（k8s.alloy）
terraform {
  required_providers {
    helm = { source = "hashicorp/helm" }
  }
}

variable "repo_root" { type = string }
variable "namespace" {
  type    = string
  default = "observability"
}
variable "log_namespace" {
  description = "收哪個 namespace 的 log"
  type        = string
}
variable "retention" {
  type    = string
  default = "72h"
}
variable "grafana_host" {
  type    = string
  default = "grafana.localhost"
}

locals {
  dashboards_dir = "${var.repo_root}/infra/grafana/dashboards"
}

resource "helm_release" "this" {
  name             = "observability"
  chart            = "${var.repo_root}/deploy/helm/observability"
  namespace        = var.namespace
  create_namespace = true
  wait             = true
  timeout          = 600

  values = [yamlencode({
    logNamespace = var.log_namespace
    retention    = var.retention
    grafanaHost  = var.grafana_host
    mysqlHost    = "mysql.${var.log_namespace}.svc.cluster.local:3306"
    lokiConfig   = file("${var.repo_root}/infra/loki/config.yaml")
    alloyConfig  = file("${var.repo_root}/infra/alloy/k8s.alloy")
    dashboards   = { for f in fileset(local.dashboards_dir, "*.json") : f => file("${local.dashboards_dir}/${f}") }
  })]
}

output "grafana_url_host" { value = var.grafana_host }
