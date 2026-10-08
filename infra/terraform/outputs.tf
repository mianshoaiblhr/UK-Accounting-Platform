output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "db_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}
