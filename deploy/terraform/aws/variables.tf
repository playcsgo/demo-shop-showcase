variable "region" {
  type    = string
  default = "ap-northeast-1" # 東京
}

variable "environment" {
  description = "prod、staging…：同一份程式碼，換這個值就開出另一套環境"
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "kubernetes_version" {
  type    = string
  default = "1.35" # 和本機 kind 叢集同一版
}

variable "node_instance_types" {
  description = "Graviton（ARM）比同級 x86 便宜約 20%；image 要 build ARM 版"
  type        = list(string)
  default     = ["m7g.large"]
}

variable "db_instance_class" {
  type    = string
  default = "db.r7g.large"
}

variable "services" {
  description = "每個服務一個 ECR repository"
  type        = list(string)
  default     = ["core-api", "core-nginx", "bff-gateway", "hub", "partners", "storefront"]
}
