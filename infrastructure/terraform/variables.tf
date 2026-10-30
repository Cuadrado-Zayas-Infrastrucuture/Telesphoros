variable "environment" {
  description = "staging or production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be \"staging\" or \"production\"."
  }
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "telesphoros"
}

variable "region" {
  description = "Primary region (database and report files)."
  type        = string
  default     = "us-east-2"
}

variable "backup_region" {
  description = "Separate region for off-site backups. Must differ from `region`."
  type        = string
  default     = "us-east-1"
  validation {
    condition     = var.backup_region != var.region
    error_message = "backup_region must be a different region from the primary."
  }
}

variable "vpc_id" {
  description = "VPC the database lives in. Created elsewhere. Required in the production profile; the synthetic profile creates its own when this is empty (network-synthetic.tf)."
  type        = string
  default     = ""
  validation {
    condition     = var.vpc_id == "" || startswith(var.vpc_id, "vpc-")
    error_message = "vpc_id must be empty or a VPC id (vpc-...)."
  }
}

variable "private_subnet_ids" {
  description = "At least two private subnets in different availability zones. Required in the production profile (profile.tf refuses fewer); the synthetic profile creates its own when vpc_id is empty."
  type        = list(string)
  default     = []
  validation {
    condition     = length(var.private_subnet_ids) == 0 || length(var.private_subnet_ids) >= 2
    error_message = "Provide at least two private subnets, or none."
  }
}

variable "app_security_group_ids" {
  description = "Security groups of the application that may connect to the database (port 5432). Nothing else can. May be empty only when enable_api_hosting is true: the API tasks' own group (api-edge.tf) is then the one allowed."
  type        = list(string)
  default     = []
}

variable "reports_cors_origins" {
  description = "Exact HTTPS browser origins allowed to retrieve report attachments, e.g. [\"https://app.telesphoros.app\"]."
  type        = list(string)
  validation {
    condition     = length(var.reports_cors_origins) >= 1 && alltrue([for o in var.reports_cors_origins : can(regex("^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$", o))])
    error_message = "List at least one exact HTTPS origin: DNS host with optional port; no wildcard, path, query, fragment or userinfo."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_allocated_storage" {
  description = "Initial storage in GiB."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB."
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = "Standby in a second availability zone. Required for production."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated RDS backup retention (point-in-time recovery window), 1-35 days."
  type        = number
  default     = 14
  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "RDS retention must be between 1 and 35 days."
  }
}

variable "aws_baa_executed" {
  description = "Set to true only when the AWS Business Associate Addendum is executed for the target account and you hold the signed copy (AWS Artifact). Production refuses even to plan without it (profile.tf). This does NOT exempt staging: README gate 1 (an executed BAA before ANY apply) still binds every environment as a human gate, unless a separately recorded founder decision defines a synthetic-only exception (docs/ops/foundations-readiness.md). It is not enforced for staging here because a precondition fires at plan time and would also block the saved-plan review that must precede an apply."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "reports_noncurrent_retention_days" {
  description = "How long an OVERWRITTEN version of a report file is kept. A captured lab PDF is pinned to an exact object version; if the file is later overwritten, the pinned version becomes noncurrent and must not expire while a capture, review or evaluation still rests on it. Never below the six-year record-retention floor (2190 days)."
  type        = number
  default     = 2190
  validation {
    condition     = var.reports_noncurrent_retention_days >= 2190
    error_message = "reports_noncurrent_retention_days must be at least 2190 (six years): evidence must outlive the records that cite it."
  }
}

variable "reports_lock_days" {
  description = "Object Lock (GOVERNANCE) on every version of a report file: nobody without the bypass right can delete or overwrite it for this many days. Never below the six-year record-retention floor (2190 days). The synthetic profile always uses 1."
  type        = number
  default     = 2190
  validation {
    condition     = var.reports_lock_days >= 2190
    error_message = "reports_lock_days must be at least 2190 (six years): evidence must outlive the records that cite it."
  }
}

variable "backup_lock_days" {
  description = "Object Lock retention on logical backups: nobody can delete or overwrite them for this long."
  type        = number
  default     = 14
}

variable "backup_lock_mode" {
  description = "GOVERNANCE (a privileged identity can override) or COMPLIANCE (nobody can, not even root: irreversible)."
  type        = string
  default     = "GOVERNANCE"
  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.backup_lock_mode)
    error_message = "backup_lock_mode must be GOVERNANCE or COMPLIANCE."
  }
}

variable "backup_retention_days" {
  description = "How long logical backups are kept before expiring. Must be at least backup_lock_days."
  type        = number
  default     = 365
}

# ------------------------------------------------------------------------------------------------
# Authentication (Cognito)
# ------------------------------------------------------------------------------------------------
variable "app_callback_urls" {
  description = "Where Cognito may send the browser after sign-in, e.g. [\"https://app.telesphoros.app/auth/callback\"]. Exact match is required."
  type        = list(string)
  validation {
    # The host must be a host (no "user@", no "localhost.attacker.example"), followed by a path. Production also refuses localhost (profile.tf).
    condition     = length(var.app_callback_urls) >= 1 && alltrue([for u in var.app_callback_urls : can(regex("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/", u)) || can(regex("^http://localhost(:[0-9]{1,5})?/", u))])
    error_message = "Callback URLs must be https://<host>[:port]/<path> (http://localhost[:port]/<path> is allowed outside production only)."
  }
}

variable "app_logout_urls" {
  description = "Where Cognito may send the browser after sign-out, e.g. [\"https://app.telesphoros.app/signed-out\"]."
  type        = list(string)
  validation {
    condition     = length(var.app_logout_urls) >= 1 && alltrue([for u in var.app_logout_urls : can(regex("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/", u)) || can(regex("^http://localhost(:[0-9]{1,5})?/", u))])
    error_message = "Logout URLs must be https://<host>[:port]/<path> (http://localhost[:port]/<path> is allowed outside production only)."
  }
}

variable "cognito_domain_prefix" {
  description = "Globally unique prefix for the sign-in page: https://<prefix>.auth.<region>.amazoncognito.com"
  type        = string
}

variable "ses_from_email" {
  description = "Sender for invitations, reset codes and password-change notices, e.g. no-reply@telesphoros.app. SES verifies its domain once the ses_dkim_records output is published in DNS."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.ses_from_email))
    error_message = "ses_from_email must be one address, like no-reply@staging.telesphoros.app; its domain becomes the SES identity."
  }
}

variable "cognito_deletion_protection" {
  description = "ACTIVE blocks deleting the user pool (and every account in it) by accident."
  type        = string
  default     = "ACTIVE"
  validation {
    condition     = contains(["ACTIVE", "INACTIVE"], var.cognito_deletion_protection)
    error_message = "cognito_deletion_protection must be ACTIVE or INACTIVE."
  }
}
