# EKS：K8s 叢集本身（M18 的 kind 換成這個）
# 叢集裡的應用程式不在這裡部署：image 由 CI 推到 ECR，Helm（或 Argo CD）部署 deploy/helm/demo-shop
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = local.name
  kubernetes_version = var.kubernetes_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  endpoint_public_access                   = true # 正式環境可以只開給公司 IP，或只走 VPN
  enable_cluster_creator_admin_permissions = true

  addons = {
    coredns                = {}
    kube-proxy             = {}
    vpc-cni                = { before_compute = true }
    eks-pod-identity-agent = { before_compute = true } # 讓 Pod 用 IAM 角色存取 SQS（見 iam.tf）
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = "AL2023_ARM_64_STANDARD"
      instance_types = var.node_instance_types
      # 本機是固定 3 個工作節點；這裡可以自動增減（之後加 Karpenter 或 Cluster Autoscaler 依 Pod 需求開機器）
      min_size     = 3
      max_size     = 10
      desired_size = 3
    }
  }
}
