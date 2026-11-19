# 上真的 AWS 的版本（只做 terraform validate，不實際建立：會花錢）
#   terraform -chdir=deploy/terraform/aws init -backend=false && terraform -chdir=deploy/terraform/aws validate
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }

  # state 放 S3：團隊共用，use_lockfile 讓兩個人不能同時 apply（Terraform 1.10 起不需要 DynamoDB 做鎖）
  # backend "s3" {
  #   bucket       = "demo-shop-terraform-state"
  #   key          = "prod/terraform.tfstate"
  #   region       = "ap-northeast-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "demo-shop", Environment = var.environment, ManagedBy = "terraform" }
  }
}
