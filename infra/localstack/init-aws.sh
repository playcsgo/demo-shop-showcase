#!/bin/bash
# LocalStack 啟動完成後建立佇列（每條都有 DLQ，失敗 5 次進 DLQ）與 S3 bucket（只有 docker compose 用；K8s 由 Terraform 建）
# 商品圖片的 bucket 最後建：compose 的 healthcheck 看它在不在，在就代表全部建好了
# 佇列清單在 queues.txt（和 Terraform 共用同一份）
set -e
grep -v -e '^#' -e '^\s*$' /etc/localstack/init/queues.txt | while read -r q; do
  awslocal sqs create-queue --queue-name "$q-dlq" >/dev/null
  DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "http://localhost:4566/000000000000/$q-dlq" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
  awslocal sqs create-queue --queue-name "$q" \
    --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\",\"VisibilityTimeout\":\"30\"}" >/dev/null
done
awslocal s3 mb s3://demo-analytics >/dev/null
awslocal s3 mb s3://demo-product-images >/dev/null   # 商品圖片（core 的 AWS_BUCKET）
echo "queues and buckets ready"
