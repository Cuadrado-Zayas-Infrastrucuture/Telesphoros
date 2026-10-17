variable "region" {
  description = "Chosen commercial AWS Region; no live default."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.region))
    error_message = "Supply a commercial AWS Region without whitespace."
  }
}

variable "bucket_name" {
  description = "Globally unique state bucket name; lowercase DNS label, no dots."
  type        = string
  nullable    = false
  validation {
    condition = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_name)) && !anytrue([
      for prefix in ["xn--", "sthree-", "amzn-s3-demo-"] : startswith(var.bucket_name, prefix)
      ]) && !anytrue([
      for suffix in ["-s3alias", "--ol-s3", "--x-s3", "--table-s3"] : endswith(var.bucket_name, suffix)
    ])
    error_message = "Use a 3–63 character lowercase bucket name without dots or AWS-reserved names."
  }
}

variable "state_key" {
  description = "Single default-workspace state object path. No other object paths are readable/writable."
  type        = string
  nullable    = false
  validation {
    condition     = length(var.state_key) <= 256 && can(regex("^[A-Za-z0-9][A-Za-z0-9/_-]*\\.tfstate$", var.state_key)) && !strcontains(var.state_key, "//")
    error_message = "Use a relative path ending .tfstate, at most 256 characters, with no wildcards, empty segments or traversal."
  }
}

variable "state_principal_arn" {
  description = "Existing trusted bootstrap/apply IAM role or user ARN. This owner can administer these policies; no identity is created."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:(role|user)/[A-Za-z0-9+=,.@_-]+(/[A-Za-z0-9+=,.@_-]+)*$", var.state_principal_arn))
    error_message = "Supply one explicit commercial IAM role/user ARN, not root, an STS session, a wildcard or a list."
  }
}

variable "noncurrent_retention_days" {
  description = "Owner-approved days before old state/lock versions expire. Current versions never expire; no unapproved retention default."
  type        = number
  nullable    = false
  validation {
    condition     = var.noncurrent_retention_days >= 1 && var.noncurrent_retention_days <= 2147483647 && floor(var.noncurrent_retention_days) == var.noncurrent_retention_days
    error_message = "Choose a positive whole number of days within the S3 integer range."
  }
}
