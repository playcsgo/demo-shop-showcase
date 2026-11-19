# Pod 存取 AWS 的權限：EKS Pod Identity（K8s 的 ServiceAccount 對應到 IAM 角色）
# 本機用假的金鑰連 LocalStack；上 AWS 後 Pod 不放任何 AWS 金鑰，權限只給需要的佇列
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "sqs" {
  statement {
    actions = [
      "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl",
    ]
    resources = module.queues.queue_arns
  }
}

locals {
  # 哪些 ServiceAccount 需要 SQS 權限：core（送指令、收事件）、hub（收指令、送事件）、KEDA（讀佇列長度）
  sqs_users = {
    core = { namespace = "demo-shop", service_account = "core" }
    hub  = { namespace = "demo-shop", service_account = "hub" }
    keda = { namespace = "keda", service_account = "keda-operator" }
  }
}

resource "aws_iam_role" "sqs" {
  for_each           = local.sqs_users
  name               = "${local.name}-${each.key}-sqs"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy" "sqs" {
  for_each = local.sqs_users
  name     = "sqs"
  role     = aws_iam_role.sqs[each.key].id
  policy   = data.aws_iam_policy_document.sqs.json
}

resource "aws_eks_pod_identity_association" "sqs" {
  for_each        = local.sqs_users
  cluster_name    = module.eks.cluster_name
  namespace       = each.value.namespace
  service_account = each.value.service_account
  role_arn        = aws_iam_role.sqs[each.key].arn
}
