# 本機整套環境（scripts/bootstrap.sh 會呼叫）：
#   kind 叢集 → 載入 image → Traefik、metrics-server、KEDA → LocalStack → 佇列（和 AWS 用同一個模組）
#   → log 系統（Alloy、Loki、Grafana）→ 應用程式（密鑰、demo-shop chart）
#   → Datadog Agent（只有設了 datadog_api_key 才裝；各服務的 trace 也跟著打開）
locals {
  repo_root = abspath("${path.root}/../../..")
  namespace = "demo-shop"
  images    = ["core-api", "core-nginx", "bff-gateway", "hub", "partners", "storefront"]
  # 佇列清單和 docker compose 共用同一份（infra/localstack/queues.txt）
  datadog = var.datadog_api_key != ""
  queues = [for l in split("\n", file("${local.repo_root}/infra/localstack/queues.txt")) : trimspace(l)
  if trimspace(l) != "" && !startswith(trimspace(l), "#")]
}

module "cluster" {
  source       = "../modules/kind-cluster"
  name         = var.cluster_name
  workers      = var.workers
  node_image   = var.node_image
  ingress_port = var.ingress_port
}

provider "kubernetes" {
  host                   = module.cluster.endpoint
  client_certificate     = module.cluster.client_certificate
  client_key             = module.cluster.client_key
  cluster_ca_certificate = module.cluster.cluster_ca_certificate
}

provider "helm" {
  kubernetes = {
    host                   = module.cluster.endpoint
    client_certificate     = module.cluster.client_certificate
    client_key             = module.cluster.client_key
    cluster_ca_certificate = module.cluster.cluster_ca_certificate
  }
}

# 本機的「AWS」是叢集裡的 LocalStack，從主機透過入口連進去；上真的 AWS 時把 endpoints 和假的金鑰拿掉
provider "aws" {
  region                      = var.region
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true
  endpoints {
    sqs = "http://localstack.localhost:${var.ingress_port}"
    s3  = "http://localstack.localhost:${var.ingress_port}"
  }
}

# 自己 build 的 image 載入每個 Node（不用架 registry）；公開的 image（MySQL、Redis…）讓 Node 自己下載
# build 不是 Terraform 的工作：由 scripts/bootstrap.sh 先 build 好，這裡只負責載入
resource "terraform_data" "images" {
  triggers_replace = [module.cluster.name, var.image_tag]
  provisioner "local-exec" {
    command = join("\n", [for s in local.images : "kind load docker-image --name ${module.cluster.name} demo-sandbox/${s}:${var.image_tag} >/dev/null"])
  }
}

module "platform" {
  source     = "../modules/platform"
  addons_dir = "${local.repo_root}/deploy/addons"
  depends_on = [module.cluster]
}

# K8s 的網頁介面（唯讀）：http://headlamp.localhost:8088
module "headlamp" {
  source     = "../modules/headlamp"
  depends_on = [module.platform]
}

resource "kubernetes_namespace_v1" "app" {
  metadata { name = local.namespace }
  depends_on = [module.cluster]
}

module "localstack" {
  source       = "../modules/localstack"
  namespace    = kubernetes_namespace_v1.app.metadata[0].name
  region       = var.region
  host         = "localstack.localhost"
  ingress_port = var.ingress_port
  depends_on   = [module.platform]
}

module "queues" {
  source     = "../modules/queues"
  queues     = local.queues
  buckets    = ["demo-analytics", "demo-product-images"] # 商品圖片：core 的 AWS_BUCKET（helm 的 global.aws.productImagesBucket）
  depends_on = [module.localstack]
}

module "observability" {
  source        = "../modules/observability"
  repo_root     = local.repo_root
  log_namespace = local.namespace
  retention     = var.log_retention
  depends_on    = [module.platform, kubernetes_namespace_v1.app]
}

module "datadog" {
  source        = "../modules/datadog"
  count         = local.datadog ? 1 : 0
  api_key       = var.datadog_api_key
  site          = var.datadog_site
  cluster_name  = "${var.cluster_name}-kind"
  app_namespace = local.namespace
  depends_on    = [module.cluster]
}

module "app" {
  source       = "../modules/demo-shop"
  repo_root    = local.repo_root
  namespace    = kubernetes_namespace_v1.app.metadata[0].name
  image_tag    = var.image_tag
  region       = var.region
  datadog      = local.datadog
  datadog_apm  = var.datadog_apm
  core_runtime = var.core_runtime
  web_runtime  = var.web_runtime
  depends_on   = [terraform_data.images, module.platform, module.queues, module.datadog]
}
