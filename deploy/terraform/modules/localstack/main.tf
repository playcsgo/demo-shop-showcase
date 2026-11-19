# LocalStack（本機模擬的 AWS：SQS、S3），跑在叢集裡
# 不放在 demo-shop 的 chart 裡，因為順序是：LocalStack 起來 → Terraform 建佇列 → 才裝應用程式
# 主機上的 Terraform 透過入口連進來（http://localstack.localhost:8088）
terraform {
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes" }
  }
}

variable "namespace" { type = string }
variable "region" { type = string }
variable "host" {
  description = "入口的主機名稱"
  type        = string
}
variable "ingress_port" { type = number }

locals {
  labels = { app = "localstack", "demo/service" = "localstack" }
}

resource "kubernetes_deployment_v1" "this" {
  metadata {
    name      = "localstack"
    namespace = var.namespace
    labels    = local.labels
  }
  spec {
    replicas = 1
    selector { match_labels = { app = "localstack" } }
    template {
      metadata { labels = local.labels }
      spec {
        container {
          name  = "localstack"
          image = "localstack/localstack:4.14"
          env {
            name  = "SERVICES"
            value = "sqs,s3"
          }
          env {
            name  = "AWS_DEFAULT_REGION"
            value = var.region
          }
          port { container_port = 4566 }
          readiness_probe {
            http_get {
              path = "/_localstack/health"
              port = 4566
            }
            period_seconds = 5
          }
          resources {
            requests = { cpu = "200m", memory = "384Mi" }
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "this" {
  metadata {
    name      = "localstack"
    namespace = var.namespace
    labels    = { app = "localstack" }
  }
  spec {
    selector = { app = "localstack" }
    port { port = 4566 }
  }
}

resource "kubernetes_ingress_v1" "this" {
  metadata {
    name      = "localstack"
    namespace = var.namespace
  }
  spec {
    rule {
      host = var.host
      http {
        path {
          path      = "/"
          path_type = "Prefix"
          backend {
            service {
              name = kubernetes_service_v1.this.metadata[0].name
              port { number = 4566 }
            }
          }
        }
      }
    }
  }
}

# 從主機連得到才算好（入口要過幾秒才知道新的路由）；之後的 aws provider 才能建佇列
resource "terraform_data" "reachable" {
  triggers_replace = [kubernetes_deployment_v1.this.id, kubernetes_ingress_v1.this.id]
  provisioner "local-exec" {
    command = <<-SH
      for i in $(seq 1 60); do
        curl -sf http://${var.host}:${var.ingress_port}/_localstack/health >/dev/null && exit 0
        sleep 2
      done
      echo "LocalStack 連不到：http://${var.host}:${var.ingress_port}" >&2; exit 1
    SH
  }
  depends_on = [kubernetes_deployment_v1.this]
}

output "endpoint" {
  value      = "http://${var.host}:${var.ingress_port}"
  depends_on = [terraform_data.reachable]
}
