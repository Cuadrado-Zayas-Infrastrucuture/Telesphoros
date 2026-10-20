# ------------------------------------------------------------------------------------------------
# Report files (genomic reports). Encrypted, versioned, private, TLS-only. The database stores
# only metadata and an object key; the bytes live here.
# ------------------------------------------------------------------------------------------------
resource "aws_s3_bucket" "reports" {
  bucket        = "${local.name}-reports-${data.aws_caller_identity.current.account_id}"
  force_destroy = local.synthetic
  # Object Lock can be switched on only when the bucket is created, so it is here from the first apply.
  object_lock_enabled = true
}

resource "aws_s3_bucket_ownership_controls" "reports" {
  bucket = aws_s3_bucket.reports.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "reports" {
  bucket                  = aws_s3_bucket.reports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "reports" {
  bucket = aws_s3_bucket.reports.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Founder decision 2026-10-19: every version of a report file is locked for six years. GOVERNANCE, not COMPLIANCE: a documented
# break-glass role (docs/ops/break-glass.md) can still remove one deliberately, and that attempt raises ReportObjectDeleted.
# A PutObject to a locked bucket must carry a checksum; s3-object-storage.checksum.spec.ts pins that the application sends one.
resource "aws_s3_bucket_object_lock_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = local.reports_lock_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.reports]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id
  rule {
    id     = "tidy-up"
    status = "Enabled"
    filter {}
    # Uploads abandoned half-way (and files that never completed verification) do not linger.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
    # NOT short: a lab PDF that a capture is pinned to becomes "noncurrent" if the key is overwritten, and it is evidence for as long
    # as the records that cite it (variables.tf enforces the six-year floor).
    noncurrent_version_expiration {
      noncurrent_days = var.reports_noncurrent_retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.reports]
}

# Browsers retrieve verified attachments with signed GET links; upload bytes go through the API.
# Local storage/browser fixtures consume this same contract. Origins remain the deployment allowlist.
locals {
  reports_cors = jsondecode(file("${path.module}/reports-cors.json"))
}
resource "aws_s3_bucket_cors_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id
  cors_rule {
    allowed_methods = local.reports_cors.allowed_methods
    allowed_origins = var.reports_cors_origins
    allowed_headers = local.reports_cors.allowed_headers
    expose_headers  = local.reports_cors.expose_headers
    max_age_seconds = local.reports_cors.max_age_seconds
  }
}

resource "aws_s3_bucket_logging" "reports" {
  bucket        = aws_s3_bucket.reports.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "reports/"
}

data "aws_iam_policy_document" "reports_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.reports.arn, "${aws_s3_bucket.reports.arn}/*"]
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
    resources = [aws_s3_bucket.reports.arn, "${aws_s3_bucket.reports.arn}/*"]
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
  # The application sends NO encryption header and relies on the bucket default (the data key). So these refuse a request only
  # when it NAMES something else: each pairs "the header is present" (Null = false) with "and it is wrong". A bare StringNotEquals
  # would also refuse every header-less upload, which is every upload the application makes.
  statement {
    sid       = "DenyOtherEncryption"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.reports.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
  statement {
    sid       = "DenyOtherKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.reports.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.data.arn]
    }
  }
  statement {
    sid       = "DenyCustomerKeys"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.reports.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-customer-algorithm"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "reports" {
  bucket     = aws_s3_bucket.reports.id
  policy     = data.aws_iam_policy_document.reports_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.reports]
}

# ------------------------------------------------------------------------------------------------
# Access logs for the reports bucket (who touched which object).
# ------------------------------------------------------------------------------------------------
resource "aws_s3_bucket" "access_logs" {
  bucket        = "${local.name}-access-logs-${data.aws_caller_identity.current.account_id}"
  force_destroy = local.synthetic
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# S3 server access logging cannot write to a KMS-encrypted bucket, so this one uses S3-managed keys.
resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = 365
    }
  }
}

data "aws_iam_policy_document" "access_logs_bucket" {
  statement {
    sid       = "AllowS3LogDelivery"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.access_logs.arn}/reports/*"]
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.reports.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.access_logs.arn, "${aws_s3_bucket.access_logs.arn}/*"]
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
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket     = aws_s3_bucket.access_logs.id
  policy     = data.aws_iam_policy_document.access_logs_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.access_logs]
}

# ------------------------------------------------------------------------------------------------
# Logical database backups: a DIFFERENT region, its own key, and Object Lock so a compromised
# application or operator account cannot quietly delete the only copy.
# ------------------------------------------------------------------------------------------------
resource "aws_s3_bucket" "backups" {
  count               = local.offsite_count
  provider            = aws.backup
  bucket              = "${local.name}-db-backups-${data.aws_caller_identity.current.account_id}"
  force_destroy       = false
  object_lock_enabled = true
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  count    = local.offsite_count
  provider = aws.backup
  bucket   = aws_s3_bucket.backups[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  count                   = local.offsite_count
  provider                = aws.backup
  bucket                  = aws_s3_bucket.backups[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  count    = local.offsite_count
  provider = aws.backup
  bucket   = aws_s3_bucket.backups[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "backups" {
  count    = local.offsite_count
  provider = aws.backup
  bucket   = aws_s3_bucket.backups[0].id
  rule {
    default_retention {
      mode = var.backup_lock_mode
      days = var.backup_lock_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  count    = local.offsite_count
  provider = aws.backup
  bucket   = aws_s3_bucket.backups[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backup[0].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  count    = local.offsite_count
  provider = aws.backup
  bucket   = aws_s3_bucket.backups[0].id
  rule {
    id     = "age-out"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
    expiration {
      days = var.backup_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.backup_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}

data "aws_iam_policy_document" "backups_bucket" {
  count = local.offsite_count
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backups[0].arn, "${aws_s3_bucket.backups[0].arn}/*"]
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
  # Backups must be encrypted with OUR key; an upload that omits or changes that is refused.
  statement {
    sid       = "DenyUnencryptedUploads"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.backups[0].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  count      = local.offsite_count
  provider   = aws.backup
  bucket     = aws_s3_bucket.backups[0].id
  policy     = data.aws_iam_policy_document.backups_bucket[0].json
  depends_on = [aws_s3_bucket_public_access_block.backups]
}
