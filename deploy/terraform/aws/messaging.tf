# 佇列和 S3：和本機用同一個模組、同一份佇列清單（infra/localstack/queues.txt）
# 差別只在 aws provider：本機指向 LocalStack，這裡是真的 AWS
locals {
  queues = [for l in split("\n", file("${path.root}/../../../infra/localstack/queues.txt")) : trimspace(l)
  if trimspace(l) != "" && !startswith(trimspace(l), "#")]
}

module "queues" {
  source  = "../modules/queues"
  queues  = local.queues
  buckets = ["${local.name}-analytics", "${local.name}-product-images"] # S3 bucket 名稱全世界唯一，加上環境名稱
}
