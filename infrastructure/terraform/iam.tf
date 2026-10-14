# Least-privilege policies, created but NOT attached: the application role and the backup job's role
# are defined where the compute is (outside this module). Attach these to them.

data "aws_iam_policy_document" "app_runtime" {
  # GetObjectVersion: evidence is always read, and linked, by an exact version. There is deliberately NO delete action here, and
  # nothing in this module grants s3:DeleteObjectVersion to anyone (a documented break-glass role outside this module may hold it).
  statement {
    sid       = "ReportFiles"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]
  }
  # The pipeline refuses to start on a bucket that does not keep versions, and asks the bucket to find out.
  statement {
    sid       = "ReportBucketVersioningCheck"
    actions   = ["s3:GetBucketVersioning"]
    resources = [aws_s3_bucket.reports.arn]
  }
  # The validated intake lists a report's own intake prefix (versions and unfinished multipart uploads) before it accepts a new attempt, and
  # treats a listing it cannot finish as "not empty". Listing only: no delete action, and only keys under reports/.
  statement {
    sid       = "ReportIntakeInventory"
    actions   = ["s3:ListBucketVersions", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.reports.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["reports/*"]
    }
  }
  # The application's own credentials write the validated bytes (and read them back), so it needs the key too.
  statement {
    sid       = "ReportFileEncryption"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "app_runtime" {
  name        = "${local.name}-app-runtime"
  description = "Report-file access for the Telesphoros API."
  policy      = data.aws_iam_policy_document.app_runtime.json
}

# Off-site backups only (absent under the synthetic profile, which has no second Region).
data "aws_iam_policy_document" "backup_job" {
  count = local.offsite_count
  statement {
    sid       = "UploadBackups"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.backups[0].arn}/*"]
  }
  statement {
    sid       = "EncryptBackups"
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = [aws_kms_key.backup[0].arn]
  }
}

resource "aws_iam_policy" "backup_job" {
  count       = local.offsite_count
  name        = "${local.name}-backup-job"
  description = "Write-only access for the backup job. It cannot read, list or delete backups."
  policy      = data.aws_iam_policy_document.backup_job[0].json
}

# The worker's task role: READ-ONLY on the report files, for the stored-file integrity re-check. No Put, no delete, no listing, no versioning check, and no
# permission to create data keys (it never writes). It reads exact versions only.
data "aws_iam_policy_document" "worker_runtime" {
  statement {
    sid       = "ReadReportFileVersions"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]
  }
  statement {
    sid       = "DecryptReportFiles"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "worker_runtime" {
  name        = "${local.name}-worker-runtime"
  description = "Read-only report-file access for the Telesphoros background worker."
  policy      = data.aws_iam_policy_document.worker_runtime.json
}
