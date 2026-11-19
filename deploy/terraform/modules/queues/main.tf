# SQS 佇列（每條都有自己的 DLQ）＋ S3 bucket
# 本機（LocalStack）和真的 AWS 用同一個模組：差別只在呼叫它的地方怎麼設定 aws provider
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "queues" {
  description = "佇列名稱；每條另外建一條 <名稱>-dlq"
  type        = list(string)
}

variable "buckets" {
  description = "S3 bucket 名稱"
  type        = list(string)
  default     = []
}

variable "visibility_timeout_seconds" {
  description = "訊息被拿走後，多久沒刪就重新出現（要大於處理一則的最長時間）"
  type        = number
  default     = 30
}

variable "max_receive_count" {
  description = "失敗幾次就進 DLQ"
  type        = number
  default     = 5
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_sqs_queue" "dlq" {
  for_each = toset(var.queues)

  name                      = "${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 天：DLQ 留久一點，才來得及查
  sqs_managed_sse_enabled   = true    # 加密（AWS 代管金鑰）
  tags                      = var.tags
}

resource "aws_sqs_queue" "this" {
  for_each = toset(var.queues)

  name                       = each.key
  visibility_timeout_seconds = var.visibility_timeout_seconds
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = var.max_receive_count
  })
  tags = var.tags
}

resource "aws_s3_bucket" "this" {
  for_each = toset(var.buckets)

  bucket = each.key
  tags   = var.tags
}

output "queue_urls" {
  value = { for k, q in aws_sqs_queue.this : k => q.url }
}

output "queue_arns" {
  value = concat([for q in aws_sqs_queue.this : q.arn], [for q in aws_sqs_queue.dlq : q.arn])
}

output "bucket_arns" {
  value = [for b in aws_s3_bucket.this : b.arn]
}
