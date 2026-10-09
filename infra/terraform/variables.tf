variable "environment" {
  type    = string
  default = "prod"
}

variable "region" {
  description = "Primary region. Must be an approved data-residency region (UK = eu-west-2 London)."
  type        = string
  default     = "eu-west-2"
  validation {
    condition     = contains(var.allowed_regions, var.region)
    error_message = "Region is not an approved data-residency region. Add it to allowed_regions only after a DPIA."
  }
}

variable "allowed_regions" {
  type    = list(string)
  default = ["eu-west-2"]
}

variable "dr_region" {
  description = "Optional DR region for backup copies / replication. null = single-region (UK only)."
  type        = string
  default     = null
  validation {
    condition     = var.dr_region == null ? true : contains(var.allowed_regions, var.dr_region)
    error_message = "dr_region must also be an approved data-residency region."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "domain_name" {
  description = "Public hostname served by the ALB, e.g. app.example.co.uk"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate (eu-west-2) for the ALB listener"
  type        = string
}

variable "ses_from_domain" {
  type = string
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "db_instance_class" {
  type    = string
  default = "db.m6g.large"
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

variable "log_retention_days" {
  type    = number
  default = 400
}

variable "alert_email" {
  description = "E-mail address subscribed to the alarm topic (confirm the subscription once). Null = topic only."
  type        = string
  default     = null
}

variable "metrics_namespace" {
  description = "CloudWatch namespace for the platform's Embedded Metric Format metrics"
  type        = string
  default     = "UkPlatform"
}

variable "db_connections_alarm_threshold" {
  description = "Alarm when RDS connections exceed this (size it to the instance class and the connection pool of api + worker tasks)"
  type        = number
  default     = 80
}
