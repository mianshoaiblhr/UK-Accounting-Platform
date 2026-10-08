terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.80" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # backend "s3" { ... }   # configure per environment (state bucket must also live in eu-west-2)
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "uk-accounting-platform", Environment = var.environment, DataResidency = "UK", ManagedBy = "terraform" }
  }
}

# Optional disaster-recovery region: only used when var.dr_region is set (backup copy, S3 replication).
provider "aws" {
  alias  = "dr"
  region = coalesce(var.dr_region, var.region)
}
