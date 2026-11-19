terraform {
  required_version = ">= 1.10"
  required_providers {
    kind       = { source = "tehcyx/kind", version = "~> 0.11" }
    helm       = { source = "hashicorp/helm", version = "~> 3.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 3.0" }
    aws        = { source = "hashicorp/aws", version = "~> 6.0" }
    random     = { source = "hashicorp/random", version = "~> 3.7" }
    tls        = { source = "hashicorp/tls", version = "~> 4.1" }
  }
  # 本機版的 state 放在這個資料夾（terraform.tfstate，裡面有密鑰，已列入 .gitignore）
  # 正式環境放 S3：見 deploy/terraform/aws/versions.tf
}
