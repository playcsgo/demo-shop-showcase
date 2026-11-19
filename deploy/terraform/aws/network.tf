# 網路：3 個可用區，每區一個公開子網路（入口的負載平衡器）、私有子網路（EKS 的 Node）、資料庫子網路（RDS、Redis，不能連外）
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "demo-shop-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 3)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = local.name
  cidr = var.vpc_cidr
  azs  = local.azs

  public_subnets   = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets  = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 4, i + 1)]
  database_subnets = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i + 48)]

  create_database_subnet_group = true

  # 私有子網路的 Pod 要連外（廠商 API、下載 image）：NAT Gateway
  # 正式環境每個可用區一個，一區掛了另外兩區還能連外；省錢的測試環境可以只開一個
  enable_nat_gateway     = true
  single_nat_gateway     = var.environment != "prod"
  one_nat_gateway_per_az = var.environment == "prod"

  # AWS Load Balancer Controller 用這些標籤找子網路，建 ALB
  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}
