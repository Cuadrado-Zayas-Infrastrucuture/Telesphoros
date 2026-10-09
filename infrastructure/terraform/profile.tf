# FD-3: the deployment profile. NOT APPLIED.
#
# `production` (the default) is the shape the product is built for: two Regions, Multi-AZ, a private network supplied by the operator,
# irreversible protections. `synthetic` is a REHEARSAL shape: one Region, small, cheap, and destroyable, so the same root can be applied
# and torn down inside the free-plan window without weakening production. It is refused for anything that is not staging, and a forgotten
# variable can never select it, because the default is `production`.
#
# Every relaxation is expressed through the locals below and nowhere else (guard test profile.guard.test.mjs); `terraform test`
# (profiles.tftest.hcl) plans each profile offline and asserts what it creates and what it refuses.

variable "deployment_profile" {
  description = "production (default) or synthetic. synthetic is a single-Region, small, destroyable rehearsal shape: allowed only with environment = \"staging\", and it holds synthetic data only. Never choose it for anything that will hold real records."
  type        = string
  default     = "production"
  validation {
    condition     = contains(["production", "synthetic"], var.deployment_profile)
    error_message = "deployment_profile must be \"production\" or \"synthetic\"."
  }
}

locals {
  synthetic = var.deployment_profile == "synthetic"

  # The off-site (second Region) resources: the backup key, the locked backups bucket, and the replication of automated database backups.
  offsite_count = local.synthetic ? 0 : 1

  # The self-contained network (network-synthetic.tf) exists only in the synthetic profile, and only when the operator did not bring a VPC.
  synthetic_network = local.synthetic && var.vpc_id == ""
  network_count     = local.synthetic_network ? 1 : 0

  # What the rest of the root uses for networking: the operator's network in production, the created one in synthetic.
  vpc_id          = local.synthetic_network ? aws_vpc.synthetic[0].id : var.vpc_id
  data_subnet_ids = local.synthetic_network ? aws_subnet.synthetic[*].id : var.private_subnet_ids
  alb_subnet_ids  = local.synthetic_network ? aws_subnet.synthetic[*].id : var.public_subnet_ids
  tasks_public_ip = local.synthetic_network

  # Small and destroyable (synthetic) versus protected (production).
  db_instance_class       = local.synthetic ? "db.t4g.micro" : var.db_instance_class
  db_multi_az             = local.synthetic ? false : var.db_multi_az
  db_deletion_protection  = local.synthetic ? false : var.db_deletion_protection
  db_backup_retention     = local.synthetic ? 1 : var.db_backup_retention_days
  db_performance_insights = !local.synthetic
  kms_deletion_days       = local.synthetic ? 7 : 30
  secret_recovery_days    = local.synthetic ? 0 : 30
  cognito_protection      = local.synthetic ? "INACTIVE" : var.cognito_deletion_protection
  audit_lock_days         = local.synthetic ? 1 : var.audit_lock_days
}

# The refusals. A check that only warns would let a mistake through, so these are preconditions on a resource that holds nothing.
resource "terraform_data" "profile" {
  input = var.deployment_profile

  lifecycle {
    precondition {
      condition     = !local.synthetic || var.environment == "staging"
      error_message = "deployment_profile = \"synthetic\" is allowed only with environment = \"staging\"."
    }
    precondition {
      condition     = var.environment != "production" || var.deployment_profile == "production"
      error_message = "environment = \"production\" requires deployment_profile = \"production\"."
    }
    precondition {
      condition     = local.vpc_id != ""
      error_message = "Set vpc_id (the VPC the database lives in). Only the synthetic profile can create one."
    }
    precondition {
      condition     = length(local.data_subnet_ids) >= 2
      error_message = "Provide at least two private subnets in different availability zones (private_subnet_ids). Only the synthetic profile can create them."
    }
    precondition {
      condition     = !local.synthetic || (var.audit_lock_mode == "GOVERNANCE" && var.backup_lock_mode == "GOVERNANCE")
      error_message = "The synthetic profile must use GOVERNANCE locks: a COMPLIANCE lock cannot be removed by anyone, so the rehearsal could never be destroyed."
    }
  }
}
