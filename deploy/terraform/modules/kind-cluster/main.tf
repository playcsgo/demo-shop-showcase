# 本機 K8s 叢集：kind（每個 Node 是一個 docker container），1 個控制節點＋N 個工作節點
# 控制節點的 port 80 對應到主機的 ingress_port（Traefik 跑在控制節點上）
terraform {
  required_providers {
    kind = { source = "tehcyx/kind" }
  }
}

variable "name" { type = string }

variable "workers" {
  type    = number
  default = 3
}

variable "node_image" {
  description = "kind 的 Node 映像（決定 K8s 版本）"
  type        = string
}

variable "ingress_port" {
  description = "主機的哪個 port 對應到叢集的入口"
  type        = number
  default     = 8088
}

resource "kind_cluster" "this" {
  name           = var.name
  node_image     = var.node_image
  wait_for_ready = true

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"
      # Traefik 用這個標籤找到控制節點
      kubeadm_config_patches = [<<-YAML
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
      YAML
      ]
      extra_port_mappings {
        container_port = 80
        host_port      = var.ingress_port
        protocol       = "TCP"
      }
    }

    dynamic "node" {
      for_each = range(var.workers)
      content {
        role = "worker"
      }
    }
  }
}

output "name" { value = kind_cluster.this.name }
output "context" { value = "kind-${kind_cluster.this.name}" }
output "endpoint" { value = kind_cluster.this.endpoint }
output "client_certificate" { value = kind_cluster.this.client_certificate }
output "client_key" {
  value     = kind_cluster.this.client_key
  sensitive = true
}
output "cluster_ca_certificate" { value = kind_cluster.this.cluster_ca_certificate }
