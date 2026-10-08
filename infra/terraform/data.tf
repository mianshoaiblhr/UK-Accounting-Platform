# ───────── Encryption keys (all in the primary UK region) ─────────
resource "aws_kms_key" "data" {
  description             = "${local.name} data (RDS, S3, Redis, secrets, backups)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_key" "logs" {
  description         = "${local.name} CloudWatch logs"
  enable_key_rotation = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Root", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.me.account_id}:root" }, Action = "kms:*", Resource = "*" },
      { Sid = "Logs", Effect = "Allow", Principal = { Service = "logs.${var.region}.amazonaws.com" }, Action = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"], Resource = "*" },
    ]
  })
}

data "aws_caller_identity" "me" {}

# ───────── Document / object storage (UK) ─────────
resource "aws_s3_bucket" "documents" {
  bucket              = "${local.name}-documents-${data.aws_caller_identity.me.account_id}"
  object_lock_enabled = true
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    default_retention {
      mode = "GOVERNANCE" # tighten to COMPLIANCE per retention policy once classes are defined (6y statutory records)
      days = 30
    }
  }
  depends_on = [aws_s3_bucket_versioning.documents]
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    id     = "noncurrent-and-multipart"
    status = "Enabled"
    filter {}
    noncurrent_version_transition {
      noncurrent_days = 90
      storage_class   = "STANDARD_IA"
    }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

data "aws_iam_policy_document" "documents_tls" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = data.aws_iam_policy_document.documents_tls.json
}

resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = ["https://${var.domain_name}"]
    allowed_headers = ["*"]
    max_age_seconds = 300
  }
}

# ───────── PostgreSQL (UK, Multi-AZ, PITR) ─────────
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_db_instance" "main" {
  identifier                            = local.name
  engine                                = "postgres"
  engine_version                        = "16"
  instance_class                        = var.db_instance_class
  allocated_storage                     = 100
  max_allocated_storage                 = 1000
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = aws_kms_key.data.arn
  db_name                               = "uk_accounting"
  username                              = "uk_migrator" # owns the schema; runs migrations only
  manage_master_user_password           = true          # secret generated & rotated by AWS Secrets Manager
  master_user_secret_kms_key_id         = aws_kms_key.data.arn
  multi_az                              = var.db_multi_az
  db_subnet_group_name                  = aws_db_subnet_group.main.name
  vpc_security_group_ids                = [aws_security_group.data.id]
  parameter_group_name                  = aws_db_parameter_group.pg16.name
  publicly_accessible                   = false
  backup_retention_period               = 35 # automated backups + point-in-time recovery
  backup_window                         = "02:00-03:00"
  copy_tags_to_snapshot                 = true
  deletion_protection                   = true
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${local.name}-final"
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
  auto_minor_version_upgrade            = true
  iam_database_authentication_enabled   = true
}

# ───────── Redis (queues) ─────────
resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "redis" {
  length  = 48
  special = false
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = local.name
  description                = "BullMQ queues"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.data.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  snapshot_retention_limit   = 7
  parameter_group_name       = "default.redis7"
  # Queues are rebuildable: job_record in Postgres is the source of truth and the sweeper re-dispatches.
}

# ───────── Secrets ─────────
resource "random_id" "field_key" {
  byte_length = 32
}

resource "aws_secretsmanager_secret" "field_key" {
  name       = "${local.name}/field-encryption-key"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "field_key" {
  secret_id     = aws_secretsmanager_secret.field_key.id
  secret_string = random_id.field_key.b64_std
}

resource "random_password" "app_db" {
  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "app_db_url" {
  name       = "${local.name}/app-database-url"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "app_db_url" {
  secret_id     = aws_secretsmanager_secret.app_db_url.id
  secret_string = "postgresql://uk_app:${random_password.app_db.result}@${aws_db_instance.main.endpoint}/uk_accounting?sslmode=require"
  # After first apply run infra/db/bootstrap.sql once with -v app_password=<random_password.app_db>
}

resource "aws_secretsmanager_secret" "redis_url" {
  name       = "${local.name}/redis-url"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
}

# ───────── Logs (sensitive business data stays in the UK region, KMS encrypted) ─────────
resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "worker", "web"])
  name              = "/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

# ───────── Backups: UK vault, daily, 35 days; optional DR copy without app changes ─────────
resource "aws_backup_vault" "main" {
  name        = local.name
  kms_key_arn = aws_kms_key.data.arn
}

resource "aws_backup_vault" "dr" {
  count       = var.dr_region == null ? 0 : 1
  provider    = aws.dr
  name        = "${local.name}-dr"
  kms_key_arn = null # DR KMS key is created with the DR stack; service default key until then
}

resource "aws_backup_plan" "daily" {
  name = local.name
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 3 * * ? *)"
    lifecycle { delete_after = 35 }
    dynamic "copy_action" {
      for_each = var.dr_region == null ? [] : [1]
      content {
        destination_vault_arn = aws_backup_vault.dr[0].arn
        lifecycle { delete_after = 35 }
      }
    }
  }
}

resource "aws_iam_role" "backup" {
  name = "${local.name}-backup"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "main" {
  name         = local.name
  plan_id      = aws_backup_plan.daily.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.main.arn]
}
