output "cluster_name" { value = module.eks.cluster_name }
output "mysql_endpoint" { value = module.mysql.db_instance_endpoint }
output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "queue_urls" { value = module.queues.queue_urls }
output "ecr_repositories" { value = { for k, r in aws_ecr_repository.service : k => r.repository_url } }
output "rds_proxy_endpoint" {
  description = "core 的 DB_HOST（經過連線池），不要直接連 mysql_endpoint"
  value       = aws_db_proxy.core.endpoint
}
