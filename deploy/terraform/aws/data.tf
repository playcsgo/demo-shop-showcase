# 資料：RDS MySQL（M18 的 mysql-0 StatefulSet 換成這個）、ElastiCache（Redis）
# 都放在資料庫子網路，只允許 EKS 的 Node 連進來
resource "aws_security_group" "data" {
  name        = "${local.name}-data"
  description = "MySQL and Redis: only from EKS nodes"
  vpc_id      = module.vpc.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "mysql_from_eks" {
  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = module.eks.node_security_group_id
  from_port                    = 3306
  to_port                      = 3306
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_eks" {
  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = module.eks.node_security_group_id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

module "mysql" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 7.0"

  identifier           = "${local.name}-core"
  engine               = "mysql"
  engine_version       = "8.4"
  family               = "mysql8.4"
  major_engine_version = "8.4"
  instance_class       = var.db_instance_class

  allocated_storage     = 100
  max_allocated_storage = 500 # 空間不夠時自動長大

  db_name  = "demo"
  username = "demo"
  # 密碼由 AWS 產生、放在 Secrets Manager，不出現在 Terraform 程式碼或 state 裡
  manage_master_user_password = true

  multi_az               = var.environment == "prod" # 一台掛了自動切到另一個可用區
  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.data.id]

  backup_retention_period = 7
  deletion_protection     = var.environment == "prod"
  skip_final_snapshot     = var.environment != "prod"

  # 和本機一樣的連線上限（多個 core Pod × FPM worker 數）
  parameters = [{ name = "max_connections", value = "400" }]
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.name}-redis"
  subnet_ids = module.vpc.database_subnets
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${local.name}-redis"
  description                = "cache, locks, BFF sessions"
  engine                     = "valkey" # Redis 的開源分支，AWS 上比 Redis 便宜，指令相容
  engine_version             = "8.0"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = var.environment == "prod" ? 2 : 1
  automatic_failover_enabled = var.environment == "prod"
  multi_az_enabled           = var.environment == "prod"
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.data.id]
  transit_encryption_enabled = true
}

# ---- RDS Proxy：core（PHP-FPM）和 RDS 之間的連線池（本機用 ProxySQL 模擬，infra/proxysql/proxysql.cnf）----
# PHP-FPM 每個請求都重新開連線；Pod 一多，連線數就會超過 RDS 的上限。Proxy 維持一組常駐連線給大家共用，
# Multi-AZ 切換時也幫應用程式接住連線。core 的 DB_HOST 指向 Proxy 的端點，不直接連 RDS
data "aws_iam_policy_document" "rds_proxy_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

# Proxy 用 RDS 自動產生、放在 Secrets Manager 的密碼登入資料庫
data "aws_iam_policy_document" "rds_proxy_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.mysql.db_instance_master_user_secret_arn]
  }
}

resource "aws_iam_role" "rds_proxy" {
  name               = "${local.name}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.rds_proxy_trust.json
}

resource "aws_iam_role_policy" "rds_proxy_secret" {
  name   = "read-db-secret"
  role   = aws_iam_role.rds_proxy.id
  policy = data.aws_iam_policy_document.rds_proxy_secret.json
}

resource "aws_db_proxy" "core" {
  name                   = "${local.name}-core"
  engine_family          = "MYSQL"
  role_arn               = aws_iam_role.rds_proxy.arn
  vpc_subnet_ids         = module.vpc.private_subnets   # 和 EKS 的 Node 同一層
  vpc_security_group_ids = [aws_security_group.data.id] # 只允許 EKS 的 Node 連 3306
  require_tls            = true
  idle_client_timeout    = 1800

  auth {
    auth_scheme               = "SECRETS"
    secret_arn                = module.mysql.db_instance_master_user_secret_arn
    iam_auth                  = "DISABLED"
    client_password_auth_type = "MYSQL_CACHING_SHA2_PASSWORD" # MySQL 8.4 的預設驗證方式
  }
}

resource "aws_db_proxy_default_target_group" "core" {
  db_proxy_name = aws_db_proxy.core.name
  connection_pool_config {
    max_connections_percent      = 90 # 最多用掉 RDS 連線上限的 90%（留一點給管理、migration）
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 30 # 連線都在用時，請求最多等 30 秒拿連線（不是直接報錯）
  }
}

resource "aws_db_proxy_target" "core" {
  db_proxy_name          = aws_db_proxy.core.name
  target_group_name      = aws_db_proxy_default_target_group.core.name
  db_instance_identifier = module.mysql.db_instance_identifier
}
