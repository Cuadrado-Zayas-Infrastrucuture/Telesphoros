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
  description = "VPC the database lives in. Created elsewhere."
  type        = string
}

variable "private_subnet_ids" {
  description = "At least two private subnets in different availability zones."
  type        = list(string)
  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Provide at least two private subnets."
  }
}

variable "app_security_group_ids" {
  description = "Security groups of the application that may connect to the database (port 5432). Nothing else can."
  type        = list(string)
  validation {
    condition     = length(var.app_security_group_ids) >= 1
    error_message = "Name at least one application security group."
  }
}

variable "reports_cors_origins" {
  description = "Browser origins allowed to upload report files directly, e.g. [\"https://app.telesphoros.app\"]."
  type        = list(string)
  validation {
    condition     = length(var.reports_cors_origins) >= 1 && alltrue([for o in var.reports_cors_origins : startswith(o, "https://")])
    error_message = "List at least one origin, and every origin must start with https://."
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

variable "db_deletion_protection" {
  type    = bool
  default = true
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
    condition     = length(var.app_callback_urls) >= 1 && alltrue([for u in var.app_callback_urls : startswith(u, "https://") || startswith(u, "http://localhost")])
    error_message = "Callback URLs must be https:// (http://localhost is allowed for development only)."
  }
}

variable "app_logout_urls" {
  description = "Where Cognito may send the browser after sign-out, e.g. [\"https://app.telesphoros.app/signed-out\"]."
  type        = list(string)
  validation {
    condition     = length(var.app_logout_urls) >= 1 && alltrue([for u in var.app_logout_urls : startswith(u, "https://") || startswith(u, "http://localhost")])
    error_message = "Logout URLs must be https:// (http://localhost is allowed for development only)."
  }
}

variable "cognito_domain_prefix" {
  description = "Globally unique prefix for the sign-in page: https://<prefix>.auth.<region>.amazoncognito.com"
  type        = string
}

variable "ses_from_email" {
  description = "Verified sender for invitations, reset codes and password-change notices, e.g. no-reply@telesphoros.app. SES sends a verification email when this is first applied."
  type        = string
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
