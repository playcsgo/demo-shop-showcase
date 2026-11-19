variable "image_tag" {
  description = "demo-sandbox/* image 的 tag（scripts/bootstrap.sh 依 git commit＋image 內容算出來）"
  type        = string
}

variable "cluster_name" {
  type    = string
  default = "demo-shop"
}

variable "workers" {
  description = "工作節點數"
  type        = number
  default     = 3
}

variable "node_image" {
  description = "要和 kind provider 內建的 kind 版本相符（tehcyx/kind 0.11 內建 kind v0.31 → K8s 1.35）；用 kind CLI 較新的 1.37 映像，kubeadm 會起不來"
  type        = string
  default     = "kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f"
}

variable "ingress_port" {
  description = "主機的入口 port：http://localhost:8088"
  type        = number
  default     = 8088
}

variable "region" {
  type    = string
  default = "ap-northeast-1"
}

variable "log_retention" {
  type    = string
  default = "72h"
}

# Datadog：根目錄 .env 的 DATA_DOG=TRUE 時，scripts/bootstrap.sh 會設定這兩個（TF_VAR_*），沒設就不裝
variable "datadog_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "datadog_site" {
  type    = string
  default = "ap1.datadoghq.com"
}

# core-api 的 PHP 執行方式：.env 的 CORE_RUNTIME（fpm／octane），scripts/bootstrap.sh 會設定 TF_VAR_core_runtime
variable "core_runtime" {
  type    = string
  default = "fpm"
  validation {
    condition     = contains(["fpm", "octane", "go"], var.core_runtime)
    error_message = "core_runtime 只能是 fpm、octane 或 go"
  }
}

# 前台＋BFF 用哪一版：.env 的 WEB_RUNTIME（nest／next），scripts/bootstrap.sh 會設定 TF_VAR_web_runtime
variable "web_runtime" {
  type    = string
  default = "nest"
  validation {
    condition     = contains(["nest", "next"], var.web_runtime)
    error_message = "web_runtime 只能是 nest 或 next"
  }
}

# .env 的 DATA_DOG_APM=FALSE：只送指標和 log、不開 APM trace（壓測用：trace 很吃 CPU，會拖慢被測的服務）
variable "datadog_apm" {
  type    = bool
  default = true
}
