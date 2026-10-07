# One customer-managed key per region. Rotation is automatic; the key policy is the account default
# (access is granted through IAM policies, see iam.tf).

resource "aws_kms_key" "data" {
  description             = "${local.name} data: database, report files"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "backup" {
  provider                = aws.backup
  description             = "${local.name} backups (separate region)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "backup" {
  provider      = aws.backup
  name          = "alias/${local.name}-backup"
  target_key_id = aws_kms_key.backup.key_id
}
