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
  # Presigned URLs are signed with the application's own credentials, so it needs the key too.
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

data "aws_iam_policy_document" "backup_job" {
  statement {
    sid       = "UploadBackups"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }
  statement {
    sid       = "EncryptBackups"
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = [aws_kms_key.backup.arn]
  }
}

resource "aws_iam_policy" "backup_job" {
  name        = "${local.name}-backup-job"
  description = "Write-only access for the backup job. It cannot read, list or delete backups."
  policy      = data.aws_iam_policy_document.backup_job.json
}
