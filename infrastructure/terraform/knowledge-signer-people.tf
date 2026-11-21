# The knowledge signers' own sign-in (audit CLIN-01, spec 033-23 H1). A signer key (knowledge-signing.tf) may be used by one IAM principal only, so each
# signer needs an identity that is theirs alone: the account's administration role is shared by design and cannot stand for a person.
#
# For each person named in knowledge_signer_people this creates:
#   - an IAM user with no access key, no console password and no MFA device. Terraform never creates those: each would put a secret in the state. The
#     founder sets a first console password by hand; the person then sets up their own MFA device and creates their own access key;
#   - a signing role that only that user can become, with an MFA code at most an hour old, for at most an hour. The role carries no policy: the key
#     policy of that person's signer key is what lets it sign. Its ARN is what knowledge_signers names (output knowledge_signer_person_role_arns).
# Synthetic staging only: production signers sign in through IAM Identity Center, not long-lived users. IAM itself is free. The founder applies this;
# an agent only prepares it.

variable "knowledge_signer_people" {
  description = "Signer ids (the same handles as in knowledge_signers, for example jan and kevin) that get their own IAM user and MFA-gated signing role. Empty (the default) creates nothing. Synthetic staging only."
  type        = list(string)
  default     = []
  validation {
    condition     = length(var.knowledge_signer_people) <= 20 && length(distinct(var.knowledge_signer_people)) == length(var.knowledge_signer_people)
    error_message = "knowledge_signer_people must name at most 20 people, each once."
  }
  validation {
    condition     = alltrue([for id in var.knowledge_signer_people : can(regex("^[a-z0-9][a-z0-9-]{1,30}$", id))])
    error_message = "Each signer id must be a short lower-case id (2 to 31 characters), as in knowledge_signers."
  }
}

locals {
  knowledge_signer_people = toset(var.knowledge_signer_people)
}

resource "aws_iam_user" "knowledge_signer_person" {
  for_each = local.knowledge_signer_people
  name     = "${local.name}-signer-${each.key}"

  lifecycle {
    precondition {
      condition     = var.environment != "production"
      error_message = "knowledge_signer_people is synthetic staging only: production signers sign in through IAM Identity Center."
    }
  }
}

# Who may become the signing role: that person's own user, with an MFA code entered within the last hour.
data "aws_iam_policy_document" "knowledge_signer_person_trust" {
  for_each = local.knowledge_signer_people
  statement {
    sid     = "ThisPersonWithFreshMfa"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_user.knowledge_signer_person[each.key].arn]
    }
    condition {
      test     = "Bool"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["true"]
    }
    condition {
      test     = "NumericLessThan"
      variable = "aws:MultiFactorAuthAge"
      values   = ["3600"]
    }
  }
}

resource "aws_iam_role" "knowledge_signer_person" {
  for_each             = local.knowledge_signer_people
  name                 = "${local.name}-knowledge-signer-${each.key}"
  description          = "Knowledge signer ${each.key}: signs with that signer's key (CLIN-01). Only ${local.name}-signer-${each.key}, with fresh MFA."
  assume_role_policy   = data.aws_iam_policy_document.knowledge_signer_person_trust[each.key].json
  max_session_duration = 3600
}

# What the user may do: look after their own password, MFA device and access keys, and become their own signing role. Every other call is denied until
# the session has MFA. sts:AssumeRole is left out of that denial because the CLI makes it with the long-term key (no MFA in that request's context);
# the role's trust itself requires the MFA code, at most an hour old.
data "aws_iam_policy_document" "knowledge_signer_person" {
  for_each = local.knowledge_signer_people
  statement {
    sid       = "AccountPasswordRules"
    actions   = ["iam:GetAccountPasswordPolicy", "iam:ListVirtualMFADevices"]
    resources = ["*"]
  }
  statement {
    sid = "OwnPasswordAndKeys"
    actions = [
      "iam:ChangePassword",
      "iam:GetUser",
      "iam:GetLoginProfile",
      "iam:UpdateLoginProfile",
      "iam:CreateAccessKey",
      "iam:DeleteAccessKey",
      "iam:ListAccessKeys",
      "iam:UpdateAccessKey",
      "iam:GetAccessKeyLastUsed",
    ]
    resources = [aws_iam_user.knowledge_signer_person[each.key].arn]
  }
  statement {
    sid       = "OwnMfaDevice"
    actions   = ["iam:CreateVirtualMFADevice", "iam:EnableMFADevice", "iam:ResyncMFADevice", "iam:ListMFADevices", "iam:DeactivateMFADevice"]
    resources = [aws_iam_user.knowledge_signer_person[each.key].arn, "arn:aws:iam::${local.audit_account_id}:mfa/${aws_iam_user.knowledge_signer_person[each.key].name}"]
  }
  statement {
    sid       = "OwnSigningRole"
    actions   = ["sts:AssumeRole"]
    resources = [aws_iam_role.knowledge_signer_person[each.key].arn]
  }
  statement {
    sid    = "NothingElseWithoutMfa"
    effect = "Deny"
    not_actions = [
      "iam:GetAccountPasswordPolicy",
      "iam:ListVirtualMFADevices",
      "iam:ChangePassword",
      "iam:GetUser",
      "iam:CreateVirtualMFADevice",
      "iam:EnableMFADevice",
      "iam:ResyncMFADevice",
      "iam:ListMFADevices",
      "sts:AssumeRole",
      "sts:GetSessionToken",
    ]
    resources = ["*"]
    condition {
      test     = "BoolIfExists"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["false"]
    }
  }
}

resource "aws_iam_user_policy" "knowledge_signer_person" {
  for_each = local.knowledge_signer_people
  name     = "own-credentials-and-signing-role"
  user     = aws_iam_user.knowledge_signer_person[each.key].name
  policy   = data.aws_iam_policy_document.knowledge_signer_person[each.key].json
}

output "knowledge_signer_person_role_arns" {
  description = "Each person's signing role: the ARN to name for that signer id in knowledge_signers. Empty while no person is named."
  value       = { for id, role in aws_iam_role.knowledge_signer_person : id => role.arn }
}

output "knowledge_signer_person_users" {
  description = "Each person's IAM user: the founder sets its first console password by hand; the person then adds their own MFA device and access key."
  value       = { for id, user in aws_iam_user.knowledge_signer_person : id => user.name }
}
