# One customer-managed key per region. Rotation is automatic; the key policy is the account default
# (access is granted through IAM policies, see iam.tf).

resource "aws_kms_key" "data" {
  description             = "${local.name} data: database, report files"
  enable_key_rotation     = true
  deletion_window_in_days = local.kms_deletion_days
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

# Off-site (second Region) key: absent under the synthetic profile, which is single-Region (profile.tf).
resource "aws_kms_key" "backup" {
  count                   = local.offsite_count
  provider                = aws.backup
  description             = "${local.name} backups (separate region)"
  enable_key_rotation     = true
  deletion_window_in_days = local.kms_deletion_days
}

resource "aws_kms_alias" "backup" {
  count         = local.offsite_count
  provider      = aws.backup
  name          = "alias/${local.name}-backup"
  target_key_id = aws_kms_key.backup[0].key_id
}
