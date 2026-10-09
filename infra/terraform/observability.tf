# ───────── Alerting (V0 Tranche A / increment 8, ADR-35) ─────────
# The API and worker write CloudWatch Embedded Metric Format lines to their log streams (METRICS_EMF=true); CloudWatch extracts the metrics
# without an agent. These alarms watch those metrics plus the native ALB / ECS / RDS metrics. Validated by `terraform validate` in CI;
# NEVER applied to a real account yet (production gate). Alarm messages carry metric names and values only, no tenant data.

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]

  # Metrics emitted by the application (see packages/core/src/metrics.ts). Dimensions must match the EMF dimension sets exactly.
  custom_alarms = {
    worker_silent = {
      description = "The worker has stopped reporting its heartbeat (no metrics for 10 minutes: crashed, stuck, or cannot reach the database)"
      metric      = "worker_heartbeat"
      dimensions  = { service = "worker" }
      statistic   = "Maximum"
      comparison  = "LessThanThreshold"
      threshold   = 1
      periods     = 2
      missing     = "breaching"
    }
    outbox_failed = {
      description = "Outbox events have FAILED and need an operator (replay or investigate): events are not reaching consumers"
      metric      = "outbox_failed"
      dimensions  = { service = "worker" }
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 0
      periods     = 1
      missing     = "notBreaching"
    }
    outbox_lag = {
      description = "The oldest unprocessed outbox event is older than 10 minutes (consumers are behind or a head event is stuck)"
      metric      = "outbox_oldest_unprocessed_seconds"
      dimensions  = { service = "worker" }
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 600
      periods     = 3
      missing     = "notBreaching"
    }
    jobs_dead = {
      description = "Background jobs are DEAD (exhausted their retries): work was lost until an operator retries it"
      metric      = "jobs"
      dimensions  = { service = "worker", status = "DEAD" }
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 0
      periods     = 1
      missing     = "notBreaching"
    }
    jobs_failing = {
      description = "Many background jobs are in FAILED state for 15 minutes (a dependency such as S3, ClamAV or SES is probably down)"
      metric      = "jobs"
      dimensions  = { service = "worker", status = "FAILED" }
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 20
      periods     = 3
      missing     = "notBreaching"
    }
    api_5xx = {
      description = "The API is returning server errors (more than 10 in 5 minutes)"
      metric      = "http_requests_total"
      dimensions  = { service = "api", status_class = "5xx" }
      statistic   = "Sum"
      comparison  = "GreaterThanThreshold"
      threshold   = 10
      periods     = 1
      missing     = "notBreaching"
    }
    login_rejected_burst = {
      description = "Many rejected logins in 5 minutes (credential stuffing or brute force)"
      metric      = "auth_login_failures_total"
      dimensions  = { service = "api", reason = "rejected" }
      statistic   = "Sum"
      comparison  = "GreaterThanThreshold"
      threshold   = 50
      periods     = 1
      missing     = "notBreaching"
    }
    login_throttled_burst = {
      description = "Many throttled logins in 5 minutes (the login rate limiter is being hit hard)"
      metric      = "auth_login_failures_total"
      dimensions  = { service = "api", reason = "throttled" }
      statistic   = "Sum"
      comparison  = "GreaterThanThreshold"
      threshold   = 20
      periods     = 1
      missing     = "notBreaching"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "custom" {
  for_each            = local.custom_alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = var.metrics_namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  period              = 300
  evaluation_periods  = each.value.periods
  treat_missing_data  = each.value.missing
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ───────── Native metrics: load balancer, ECS services, database ─────────
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-alb-5xx"
  alarm_description   = "The load balancer or the web targets are returning 5xx responses"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  alarm_name          = "${local.name}-unhealthy-web-targets"
  alarm_description   = "At least one web target is failing its health check"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 60
  evaluation_periods  = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each            = local.services
  alarm_name          = "${local.name}-${each.key}-cpu"
  alarm_description   = "ECS service ${each.key} CPU is above 85% for 15 minutes"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.svc[each.key].name }
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 85
  period              = 300
  evaluation_periods  = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  for_each            = local.services
  alarm_name          = "${local.name}-${each.key}-memory"
  alarm_description   = "ECS service ${each.key} memory is above 85% for 15 minutes"
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.svc[each.key].name }
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 85
  period              = 300
  evaluation_periods  = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name}-rds-cpu"
  alarm_description   = "Database CPU is above 80% for 15 minutes"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  period              = 300
  evaluation_periods  = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${local.name}-rds-connections"
  alarm_description   = "Database connections are close to exhaustion (api and worker tasks each hold a connection pool)"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.db_connections_alarm_threshold
  period              = 300
  evaluation_periods  = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${local.name}-rds-free-storage"
  alarm_description   = "Database free storage is below 10 GiB"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  comparison_operator = "LessThanThreshold"
  threshold           = 10737418240
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
