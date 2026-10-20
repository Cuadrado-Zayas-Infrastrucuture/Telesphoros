# The data and backup keys: one customer-managed key per region. Rotation is automatic; the key policy is the account default
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

# ------------------------------------------------------------------------------------------------
# The logs AWS services write for us: the database's exported logs (database.tf) and the password-change notifier's (lambda.tf). Their own key, not the
# data key and not the audit key, usable only by the log service and only for these groups (audit finding INF-12).
# ------------------------------------------------------------------------------------------------
locals {
  password_notifier_log_group = "/aws/lambda/${local.name}-password-notifier"
  service_log_groups          = concat([for log in local.rds_log_exports : "/aws/rds/instance/${local.name}/${log}"], [local.password_notifier_log_group])
}

data "aws_iam_policy_document" "service_logs_key" {
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
    sid       = "CloudWatchLogsEncryptTheServiceLogGroups"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = [for name in local.service_log_groups : "arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${name}"]
    }
  }
}

resource "aws_kms_key" "service_logs" {
  description             = "${local.name} service logs: database exports, password-change notifier"
  enable_key_rotation     = true
  deletion_window_in_days = local.kms_deletion_days
  policy                  = data.aws_iam_policy_document.service_logs_key.json
}

resource "aws_kms_alias" "service_logs" {
  name          = "alias/${local.name}-service-logs"
  target_key_id = aws_kms_key.service_logs.key_id
}
