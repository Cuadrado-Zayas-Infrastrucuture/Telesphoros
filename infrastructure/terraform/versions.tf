terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # No backend is configured on purpose. Before the first apply, add a remote backend (S3 with
  # locking, encrypted, access-restricted): the state holds resource identifiers and must be protected.
}

locals {
  name = "${var.name_prefix}-${var.environment}"
  tags = {
    Project   = "telesphoros-remastered"
    Component = "data-plane"
    # The data classification of what these resources WILL hold once live. Synthetic data only until then.
    DataClassification = "phi"
    Environment        = var.environment
    DeploymentProfile  = var.deployment_profile # lets a rehearsal's leftovers be found by tag
    ManagedBy          = "terraform"
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = local.tags
  }
}

# The "separate location" for backups: a different region, with its own encryption key.
provider "aws" {
  alias  = "backup"
  region = var.backup_region
  default_tags {
    tags = local.tags
  }
}

data "aws_caller_identity" "current" {}
