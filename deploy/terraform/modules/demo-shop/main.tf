# 應用程式：密鑰（隨機產生）、MySQL 初始化 SQL、demo-shop 總 chart（deploy/helm/demo-shop）
terraform {
  required_providers {
    helm       = { source = "hashicorp/helm" }
    kubernetes = { source = "hashicorp/kubernetes" }
    random     = { source = "hashicorp/random" }
    tls        = { source = "hashicorp/tls" }
  }
}

variable "repo_root" { type = string }
variable "namespace" { type = string }
variable "image_tag" { type = string }
variable "region" { type = string }
variable "datadog" {
  description = "各服務的 trace、指標送到 Datadog Agent（Agent 由 modules/datadog 安裝）"
  type        = bool
  default     = false
}
variable "datadog_apm" {
  description = "開 Datadog 時要不要送 APM trace（false：只送指標和 log，壓測用）"
  type        = bool
  default     = true
}
variable "core_runtime" {
  type    = string
  default = "fpm"
}
variable "web_runtime" {
  type    = string
  default = "nest"
}

# ---- 密鑰：第一次 apply 產生，之後沿用（存在 Terraform 的 state 裡，state 不進 git）----
# 所有 core-api Pod 要用同一組 APP_KEY、JWT 金鑰（BFF 用公鑰驗章）
resource "random_bytes" "app_key" {
  length = 32
}

resource "tls_private_key" "jwt" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

# 服務之間的共用密鑰：兩端讀同一個值（chart 的 global.secrets）
resource "random_password" "shared" {
  for_each = toset(["internalApiKey", "bffServiceKey", "mockpayWebhookSecret", "mocklogiWebhookSecret"])
  length   = 32
  special  = false
}

resource "kubernetes_secret_v1" "core" {
  metadata {
    name      = "core-secrets"
    namespace = var.namespace
  }
  data = {
    APP_KEY           = "base64:${random_bytes.app_key.base64}"
    "jwt-private.pem" = tls_private_key.jwt.private_key_pem_pkcs8
    "jwt-public.pem"  = tls_private_key.jwt.public_key_pem
  }
}

# MySQL 第一次啟動時執行（建資料庫、Grafana 的唯讀帳號）：和 docker compose 同一份
resource "kubernetes_config_map_v1" "mysql_init" {
  metadata {
    name      = "mysql-init"
    namespace = var.namespace
  }
  data = {
    "init.sql" = file("${var.repo_root}/infra/mysql/init.sql")
  }
}

resource "helm_release" "this" {
  name      = "demo"
  chart     = "${var.repo_root}/deploy/helm/demo-shop"
  namespace = var.namespace
  wait      = true
  timeout   = 900 # 第一次要等 MySQL 起來、跑 migration、灌資料

  # 設定檔和 docker compose 同一份：連線池（ProxySQL）；Go 版直連 MySQL，不開 ProxySQL
  values = [yamlencode({ infra = { proxysql = {
    config   = file("${var.repo_root}/infra/proxysql/proxysql.cnf")
    replicas = var.core_runtime == "go" ? 0 : 2
  } } })]

  set = [
    { name = "global.image.tag", value = var.image_tag },
    { name = "global.aws.region", value = var.region },
    { name = "global.datadog.enabled", value = tostring(var.datadog) },
    { name = "global.datadog.apm", value = tostring(var.datadog_apm) },
    { name = "core.api.runtime", value = var.core_runtime },
    { name = "global.webRuntime", value = var.web_runtime },
    { name = "storefront.enabled", value = tostring(var.web_runtime != "next") }, # Next.js 版：頁面由 bff 提供
  ]
  set_sensitive = [for k, p in random_password.shared : { name = "global.secrets.${k}", value = p.result }]

  depends_on = [kubernetes_secret_v1.core, kubernetes_config_map_v1.mysql_init]
}
