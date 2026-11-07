# Knowledge signing keys (audit CLIN-01). A real reviewed knowledge file loads under the production rules only with signatures from two distinct signers whose
# public keys the API is given in KNOWLEDGE_SIGNER_KEYS (apps/backend/src/services/knowledge/signatures.ts). Each signer has one KMS key that only that signer
# may sign with; the public keys reach the API task from here, so neither the repository nor anyone with write access to it decides who counts as a signer.
#
# Nothing exists until the founder names the signers (knowledge_signers). Two asymmetric keys cost about $1 a month each; signing happens a few times per
# released file. The founder applies this; an agent only prepares it.

variable "knowledge_signers" {
  description = "Signer key id => the IAM principal ARN that alone may sign with that signer's key. Empty (the default) creates nothing; otherwise at least two (the rule is two distinct signers)."
  type        = map(string)
  default     = {}
  validation {
    condition     = length(var.knowledge_signers) == 0 || (length(var.knowledge_signers) >= 2 && length(var.knowledge_signers) <= 20)
    error_message = "knowledge_signers must be empty, or name from 2 to 20 signers."
  }
  validation {
    condition     = alltrue([for id, arn in var.knowledge_signers : can(regex("^[a-z0-9][a-z0-9-]{1,62}$", id)) && can(regex("^arn:aws:iam::[0-9]{12}:(role|user)/[A-Za-z0-9+=,.@_/-]+$", arn))])
    error_message = "Each key id must be a short lower-case id, and each principal an IAM role or user ARN."
  }
  validation {
    condition     = length(distinct(values(var.knowledge_signers))) == length(var.knowledge_signers)
    error_message = "Each signer must be a different principal: one person cannot hold two signers' keys."
  }
}

data "aws_iam_policy_document" "knowledge_signer_key" {
  for_each = var.knowledge_signers
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
    sid       = "NobodyElseSigns"
    effect    = "Deny"
    actions   = ["kms:Sign"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [each.value]
    }
  }
  statement {
    sid       = "TheSignerSigns"
    actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [each.value]
    }
  }
}

# Asymmetric, signing only, as the image-signing key (signing.tf): KMS cannot rotate an asymmetric key, so rotation is a new key and re-signing.
resource "aws_kms_key" "knowledge_signer" {
  for_each                 = var.knowledge_signers
  description              = "${local.name} knowledge signer ${each.key}: signs real knowledge files for the production load (CLIN-01)"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = local.kms_deletion_days
  policy                   = data.aws_iam_policy_document.knowledge_signer_key[each.key].json
}

resource "aws_kms_alias" "knowledge_signer" {
  for_each      = var.knowledge_signers
  name          = "alias/${local.name}-knowledge-signer-${each.key}"
  target_key_id = aws_kms_key.knowledge_signer[each.key].key_id
}

data "aws_kms_public_key" "knowledge_signer" {
  for_each = var.knowledge_signers
  key_id   = aws_kms_key.knowledge_signer[each.key].arn
}

locals {
  # Public keys only: KNOWLEDGE_SIGNER_KEYS is not a secret. Absent while no signer is named, so the API then refuses any signed real file.
  knowledge_signer_environment = length(var.knowledge_signers) == 0 ? {} : {
    KNOWLEDGE_SIGNER_KEYS = jsonencode({ for id, key in data.aws_kms_public_key.knowledge_signer : id => key.public_key_pem })
  }
}

output "knowledge_signer_key_arns" {
  description = "What each signer passes to knowledge:sign --kms-key. Empty while no signer is named."
  value       = { for id, key in aws_kms_key.knowledge_signer : id => key.arn }
}
