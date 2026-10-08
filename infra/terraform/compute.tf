# ───────── Container registry ─────────
resource "aws_ecr_repository" "app" {
  for_each             = toset(["api", "worker", "web", "migrate"])
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ───────── IAM ─────────
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "exec" {
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "exec_secrets" {
  role = aws_iam_role.exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "kms:Decrypt"]
      Resource = [aws_secretsmanager_secret.field_key.arn, aws_secretsmanager_secret.app_db_url.arn, aws_secretsmanager_secret.redis_url.arn, aws_kms_key.data.arn]
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task" {
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.documents.arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.documents.arn },
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = aws_kms_key.data.arn },
      { Effect = "Allow", Action = ["ses:SendEmail", "ses:SendRawEmail"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
    ]
  })
}

# ───────── Load balancer + WAF ─────────
resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check { path = "/login" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_wafv2_web_acl" "main" {
  name  = local.name
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  dynamic "rule" {
    for_each = {
      common    = { group = "AWSManagedRulesCommonRuleSet", priority = 1 }
      badinputs = { group = "AWSManagedRulesKnownBadInputsRuleSet", priority = 2 }
      sqli      = { group = "AWSManagedRulesSQLiRuleSet", priority = 3 }
    }
    content {
      name     = rule.key
      priority = rule.value.priority
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          name        = rule.value.group
          vendor_name = "AWS"
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "main" {
  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}

# ───────── Services ─────────
locals {
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "AWS_REGION", value = var.region },
    { name = "DATA_RESIDENCY_REGIONS", value = join(",", var.allowed_regions) },
    { name = "STORAGE_DRIVER", value = "s3" },
    { name = "S3_BUCKET", value = aws_s3_bucket.documents.bucket },
    { name = "S3_KMS_KEY_ID", value = aws_kms_key.data.arn },
    { name = "EMAIL_DRIVER", value = "ses" },
    { name = "EMAIL_FROM", value = "no-reply@${var.ses_from_domain}" },
    { name = "AV_DRIVER", value = "clamav" },
    { name = "APP_BASE_URL", value = "https://${var.domain_name}" },
    { name = "CORS_ORIGINS", value = "https://${var.domain_name}" },
    { name = "TRUST_PROXY_HOPS", value = "1" },
  ]
  common_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.app_db_url.arn },
    { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
    { name = "FIELD_ENCRYPTION_KEY", valueFrom = aws_secretsmanager_secret.field_key.arn },
  ]
  services = {
    api    = { port = 4000, cpu = 512, memory = 1024, count = var.api_desired_count, env = [{ name = "API_PORT", value = "4000" }] }
    worker = { port = 0, cpu = 1024, memory = 2048, count = var.worker_desired_count, env = [{ name = "WORKER_CONCURRENCY", value = "5" }] }
    web    = { port = 3000, cpu = 256, memory = 512, count = 2, env = [{ name = "API_INTERNAL_URL", value = "http://api.${local.name}.internal:4000" }] }
  }
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name                   = each.key
    image                  = "${aws_ecr_repository.app[each.key].repository_url}:${var.image_tag}"
    essential              = true
    portMappings           = each.value.port == 0 ? [] : [{ containerPort = each.value.port }]
    environment            = concat(local.common_env, each.value.env)
    secrets                = each.key == "web" ? [] : local.common_secrets
    readonlyRootFilesystem = true
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.app[each.key].name, "awslogs-region" = var.region, "awslogs-stream-prefix" = each.key }
    }
  }])
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = "${local.name}.internal"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "api" {
  name = "api"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
}

resource "aws_ecs_service" "svc" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.svc[each.key].arn
  desired_count   = each.value.count
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  dynamic "load_balancer" {
    for_each = each.key == "web" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.web.arn
      container_name   = "web"
      container_port   = 3000
    }
  }
  dynamic "service_registries" {
    for_each = each.key == "api" ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.api.arn
    }
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.https]
}

# ───────── Email (SES in London) ─────────
resource "aws_sesv2_email_identity" "from" {
  email_identity = var.ses_from_domain
}
