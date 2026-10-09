# F1: the audit trail. NOT APPLIED.
#
# CloudTrail records who did what in the AWS account, including every read and delete of a report file
# (S3 data events on the reports bucket). The logs go to a bucket nobody can quietly rewrite (Object Lock, its own
# KMS key, signed digest files), and a few events raise an alarm by email. docs/ops/audit-trail.md says what is recorded,
# what each alarm means, and what is not covered.

variable "alarm_email" {
  description = "Where audit alarms are emailed (an SNS subscription the owner must confirm). No default on purpose: set it in your tfvars."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be an email address."
  }
}

variable "audit_lock_mode" {
  description = "Object Lock mode for the audit logs. GOVERNANCE (a privileged identity can override) while the set-up is proven; COMPLIANCE (nobody can, not even root) is irreversible and a separate decision."
  type        = string
  default     = "GOVERNANCE"
  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.audit_lock_mode)
    error_message = "audit_lock_mode must be GOVERNANCE or COMPLIANCE."
  }
}

variable "audit_lock_days" {
  description = "Nobody (in GOVERNANCE mode, nobody without the bypass right) can delete or overwrite an audit log for this many days. The synthetic profile always uses 1."
  type        = number
  default     = 365
  validation {
    condition     = var.audit_lock_days >= 1 && var.audit_lock_days <= var.audit_log_retention_days
    error_message = "audit_lock_days must be at least 1 and no more than audit_log_retention_days."
  }
}

variable "audit_log_retention_days" {
  description = "How long audit logs are kept. Never below the six-year record-retention floor (2190 days)."
  type        = number
  default     = 2190
  validation {
    condition     = var.audit_log_retention_days >= 2190
    error_message = "audit_log_retention_days must be at least 2190 (six years)."
  }
}

variable "break_glass_role_name" {
  description = "Name (no path) of the break-glass role described in docs/ops/break-glass.md. The role is NOT created here; any attempt to assume it raises an alarm."
  type        = string
  default     = "telesphoros-break-glass-delete-versions"
  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.break_glass_role_name))
    error_message = "break_glass_role_name must be an IAM role name without a path."
  }
}

locals {
  audit_account_id = data.aws_caller_identity.current.account_id
  audit_trail_name = "${local.name}-audit"
  # Built from its parts (not from the trail resource) so the bucket and key policies can name it without a cycle.
  audit_trail_arn = "arn:aws:cloudtrail:${var.region}:${local.audit_account_id}:trail/${local.audit_trail_name}"
  audit_log_group = "/aws/cloudtrail/${local.audit_trail_name}"
  audit_metrics   = "${local.name}/Audit"
  # The off-site backups bucket exists only in the production profile (profile.tf), so it is listed only then.
  audit_buckets = concat([aws_s3_bucket.reports.bucket, aws_s3_bucket.audit.bucket], aws_s3_bucket.backups[*].bucket)

  # One alarm per entry: a CloudWatch Logs metric filter over the trail, and an alarm on its metric.
  audit_alarms = {
    ReportObjectDeleted = {
      description = "A report file or one of its versions was deleted (or someone tried). The application cannot delete report files, so this is a person: check docs/ops/break-glass.md."
      pattern     = "{ ($.eventSource = \"s3.amazonaws.com\") && (($.eventName = \"DeleteObjectVersion\") || ($.eventName = \"DeleteObject\") || ($.eventName = \"DeleteObjects\")) && ($.requestParameters.bucketName = \"${aws_s3_bucket.reports.bucket}\") }"
    }
    BreakGlassRoleAssumed = {
      description = "The break-glass role was assumed (or someone tried). Expected only with a written decision record: docs/ops/break-glass.md."
      pattern     = "{ ($.eventSource = \"sts.amazonaws.com\") && ($.eventName = \"AssumeRole\") && ($.requestParameters.roleArn = \"arn:aws:iam::${local.audit_account_id}:role/${var.break_glass_role_name}\") }"
    }
    RootAccountUsed = {
      description = "The AWS root account was used. It should never be, day to day."
      pattern     = "{ ($.userIdentity.type = \"Root\") && ($.userIdentity.invokedBy NOT EXISTS) && ($.eventType != \"AwsServiceEvent\") }"
    }
    AuditTrailChanged = {
      description = "Someone stopped, deleted or changed the audit trail. Treat as an attempt to hide activity."
      pattern     = "{ ($.eventSource = \"cloudtrail.amazonaws.com\") && (($.eventName = \"StopLogging\") || ($.eventName = \"DeleteTrail\") || ($.eventName = \"UpdateTrail\") || ($.eventName = \"PutEventSelectors\") || ($.eventName = \"PutInsightSelectors\")) }"
    }
    DataBucketProtectionChanged = {
      description = "The policy, public-access block, lock, versioning or lifecycle of the reports, audit or backup bucket was changed."
      pattern     = "{ ($.eventSource = \"s3.amazonaws.com\") && (($.eventName = \"PutBucketPolicy\") || ($.eventName = \"DeleteBucketPolicy\") || ($.eventName = \"PutBucketPublicAccessBlock\") || ($.eventName = \"DeletePublicAccessBlock\") || ($.eventName = \"PutBucketAcl\") || ($.eventName = \"PutBucketVersioning\") || ($.eventName = \"PutObjectLockConfiguration\") || ($.eventName = \"PutBucketLifecycle\") || ($.eventName = \"PutBucketLifecycleConfiguration\")) && (${join(" || ", [for b in local.audit_buckets : "($.requestParameters.bucketName = \"${b}\")"])}) }"
    }
    EncryptionKeyChanged = {
      description = "A KMS key was disabled, had its rotation turned off, its policy replaced, or was scheduled for deletion. Data encrypted with it could become unreadable."
      pattern     = "{ ($.eventSource = \"kms.amazonaws.com\") && (($.eventName = \"DisableKey\") || ($.eventName = \"ScheduleKeyDeletion\") || ($.eventName = \"PutKeyPolicy\") || ($.eventName = \"DisableKeyRotation\")) }"
    }
  }
}

# ---- The key: dedicated, so a stolen application role cannot read or alter the audit logs ----
data "aws_iam_policy_document" "audit_key" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.audit_account_id}:root"]
    }
  }
  statement {
    sid       = "CloudTrailEncryptLogs"
    actions   = ["kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = ["arn:aws:cloudtrail:*:${local.audit_account_id}:trail/*"]
    }
  }
  statement {
    sid       = "CloudTrailDescribeKey"
    actions   = ["kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
  statement {
    sid       = "CloudWatchLogsEncryptTheTrailLogGroup"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.audit_log_group}"]
    }
  }
  statement {
    sid       = "CloudWatchAlarmsPublishToTheEncryptedTopic"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.audit_account_id]
    }
  }
}

resource "aws_kms_key" "audit" {
  description             = "${local.name} audit trail logs and alarm topic"
  enable_key_rotation     = true
  deletion_window_in_days = local.kms_deletion_days
  policy                  = data.aws_iam_policy_document.audit_key.json
}

resource "aws_kms_alias" "audit" {
  name          = "alias/${local.name}-audit"
  target_key_id = aws_kms_key.audit.key_id
}

# ---- The log bucket: private, versioned, locked, encrypted with the audit key, TLS-only ----
resource "aws_s3_bucket" "audit" {
  bucket              = "${local.name}-audit-${local.audit_account_id}"
  force_destroy       = local.synthetic
  object_lock_enabled = true
}

resource "aws_s3_bucket_ownership_controls" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    default_retention {
      mode = var.audit_lock_mode
      days = local.audit_lock_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.audit]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.audit.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    id     = "keep-six-years"
    status = "Enabled"
    filter {}
    expiration {
      days = var.audit_log_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.audit_log_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  depends_on = [aws_s3_bucket_versioning.audit]
}

data "aws_iam_policy_document" "audit_bucket" {
  statement {
    sid       = "CloudTrailChecksTheBucketAcl"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }
  statement {
    sid       = "CloudTrailWritesThisAccountsLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/AWSLogs/${local.audit_account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.audit.arn, "${aws_s3_bucket.audit.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "DenyOldTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.audit.arn, "${aws_s3_bucket.audit.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "NumericLessThan"
      variable = "s3:TlsVersion"
      values   = ["1.2"]
    }
  }
}

resource "aws_s3_bucket_policy" "audit" {
  bucket     = aws_s3_bucket.audit.id
  policy     = data.aws_iam_policy_document.audit_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.audit]
}

# ---- A CloudWatch copy of the trail, only so metric filters can raise alarms. The S3 bucket is the record. ----
resource "aws_cloudwatch_log_group" "audit" {
  name              = local.audit_log_group
  retention_in_days = 365
  kms_key_id        = aws_kms_key.audit.arn
}

data "aws_iam_policy_document" "audit_trail_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }
}

data "aws_iam_policy_document" "audit_trail_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.audit.arn}:log-stream:*"]
  }
}

resource "aws_iam_role" "audit_trail_logs" {
  name               = "${local.name}-audit-trail-to-logs"
  assume_role_policy = data.aws_iam_policy_document.audit_trail_assume.json
}

resource "aws_iam_role_policy" "audit_trail_logs" {
  name   = "write-trail-events"
  role   = aws_iam_role.audit_trail_logs.id
  policy = data.aws_iam_policy_document.audit_trail_logs.json
}

# ---- The trail ----
resource "aws_cloudtrail" "audit" {
  name                          = local.audit_trail_name
  s3_bucket_name                = aws_s3_bucket.audit.id
  kms_key_id                    = aws_kms_key.audit.arn
  is_multi_region_trail         = !local.synthetic
  include_global_service_events = true
  enable_log_file_validation    = true
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.audit.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.audit_trail_logs.arn

  # Every management event, plus every read and write of an object in the reports bucket (the trailing slash means "all objects").
  event_selector {
    read_write_type           = "All"
    include_management_events = true
    data_resource {
      type   = "AWS::S3::Object"
      values = ["${aws_s3_bucket.reports.arn}/"]
    }
  }

  depends_on = [aws_s3_bucket_policy.audit, aws_iam_role_policy.audit_trail_logs]
}

# ---- Alarms ----
resource "aws_sns_topic" "audit_alarms" {
  name              = "${local.name}-audit-alarms"
  kms_master_key_id = aws_kms_key.audit.arn
}

resource "aws_sns_topic_subscription" "audit_alarms_email" {
  topic_arn = aws_sns_topic.audit_alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_log_metric_filter" "audit" {
  for_each       = local.audit_alarms
  name           = "${local.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.audit.name
  pattern        = each.value.pattern
  metric_transformation {
    name      = each.key
    namespace = local.audit_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit" {
  for_each            = local.audit_alarms
  alarm_name          = "${local.name}-audit-${each.key}"
  alarm_description   = each.value.description
  namespace           = local.audit_metrics
  metric_name         = each.key
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.audit]
}
