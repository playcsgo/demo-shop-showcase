# Headlamp：K8s 的網頁介面（Kubernetes SIG UI 維護，取代已停止維護的 Kubernetes Dashboard）
# http://headlamp.localhost:8088：看 Node、Pod、Deployment、HPA、事件、log
#
# 權限只給「唯讀」：chart 預設綁 cluster-admin（什麼都能改、能看 Secret），這裡改成
#   K8s 內建的 view（不含 Secret）＋看 Node、namespace、CPU 用量
# unsafeUseServiceAccountToken：不用登入，所有人都用 Headlamp 自己的唯讀身分。只限本機 demo；
#   正式環境要放在 OIDC 登入後面，每個人用自己的身分（不要開這個）
terraform {
  required_providers {
    helm       = { source = "hashicorp/helm" }
    kubernetes = { source = "hashicorp/kubernetes" }
  }
}

variable "host" {
  type    = string
  default = "headlamp.localhost"
}

locals {
  namespace = "headlamp"
  sa        = "headlamp"
}

resource "helm_release" "this" {
  name             = "headlamp"
  repository       = "https://kubernetes-sigs.github.io/headlamp/"
  chart            = "headlamp"
  version          = "0.45.0"
  namespace        = local.namespace
  create_namespace = true
  atomic           = true

  values = [yamlencode({
    config             = { unsafeUseServiceAccountToken = true }
    serviceAccount     = { create = true, name = local.sa }
    clusterRoleBinding = { create = false } # 不要 cluster-admin，權限在下面自己給
    ingress = {
      enabled          = true
      ingressClassName = "traefik"
      hosts            = [{ host = var.host, paths = [{ path = "/", type = "Prefix" }] }]
    }
  })]
}

# 唯讀：K8s 內建的 view（Pod、Deployment、HPA、Service、事件…，不含 Secret）
resource "kubernetes_cluster_role_binding_v1" "view" {
  metadata { name = "headlamp-view" }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = "view"
  }
  subject {
    kind      = "ServiceAccount"
    name      = local.sa
    namespace = local.namespace
  }
  depends_on = [helm_release.this]
}

# view 沒有包含的「整個叢集層級」的東西：Node、namespace、儲存、CPU 用量、KEDA 的擴充設定
resource "kubernetes_cluster_role_v1" "cluster_read" {
  metadata { name = "headlamp-cluster-read" }
  rule {
    api_groups = [""]
    resources  = ["nodes", "namespaces", "persistentvolumes"]
    verbs      = ["get", "list", "watch"]
  }
  rule {
    api_groups = ["storage.k8s.io", "networking.k8s.io", "apiextensions.k8s.io"]
    resources  = ["storageclasses", "ingressclasses", "customresourcedefinitions"]
    verbs      = ["get", "list", "watch"]
  }
  rule {
    api_groups = ["metrics.k8s.io"]
    resources  = ["nodes", "pods"]
    verbs      = ["get", "list"]
  }
  rule {
    api_groups = ["keda.sh"]
    resources  = ["scaledobjects", "triggerauthentications"]
    verbs      = ["get", "list", "watch"]
  }
}

resource "kubernetes_cluster_role_binding_v1" "cluster_read" {
  metadata { name = "headlamp-cluster-read" }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role_v1.cluster_read.metadata[0].name
  }
  subject {
    kind      = "ServiceAccount"
    name      = local.sa
    namespace = local.namespace
  }
  depends_on = [helm_release.this]
}
