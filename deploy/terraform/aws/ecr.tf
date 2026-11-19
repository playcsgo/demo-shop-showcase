# image 倉庫：CI build 完推到這裡，EKS 的 Node 用 IAM 權限拉（不用密碼）
resource "aws_ecr_repository" "service" {
  for_each = toset(var.services)

  name                 = "demo-shop/${each.key}"
  image_tag_mutability = "IMMUTABLE" # 一個 tag 只對應一個版本，不能覆蓋（本機用「commit＋內容雜湊」當 tag 也是這個原因）
  image_scanning_configuration {
    scan_on_push = true # 推上來就掃描已知漏洞
  }
}

# 舊的 image 自動清掉，只留最近 30 個
resource "aws_ecr_lifecycle_policy" "keep_recent" {
  for_each   = aws_ecr_repository.service
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}
