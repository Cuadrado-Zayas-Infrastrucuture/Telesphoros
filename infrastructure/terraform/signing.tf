# INF-03 slice 1 (specs/002-signed-image-release, plan approved by the founder 2026-10-20): the image-signing key, the GitHub OIDC trust and the CI release
# role. It exists only with API hosting on AND the GitHub repository named by its immutable IDs (or, on synthetic staging, named roles: D6 below);
# until the founder sets those, nothing here is planned and the CI release job (slice 2) skips itself.
#
# What it is for: CI pushes the exact image archive its `image` job built, scanned and rehearsed, and signs that digest with this key; an apply refuses an
# `api_image` without a valid signature (slice 3). The key never leaves KMS, nothing is written to a public transparency log, and only the release job on
# `main`, in the `image-release` GitHub environment, can sign.
#
# Synthetic staging only (spec 002 D6, founder decision 2026-11-03): where the account cannot hold a GitHub OIDC provider (the AWS-managed project
# SCP denies iam:*Provider*), `image_release_human_principals` lets named roles of this account become the same release role, so a person runs
# `release-image.sh` on the archive CI built, scanned and rehearsed. The key policy is unchanged: the release role is still the only signer. Production
# refuses the list (precondition below and registry.tf).

variable "github_repository" {
  description = "The repository whose CI may sign images, as owner/name (used only in the workflow path the trust policy pins). Set together with the two IDs, or leave all three empty."
  type        = string
  default     = ""
  validation {
    condition     = var.github_repository == "" || can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be owner/name."
  }
}

variable "github_repository_id" {
  description = "The repository's numeric ID (gh api repos/<owner>/<name> --jq .id). Names can be renamed and reclaimed; the ID cannot, so the trust policy pins it."
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^([0-9]+)?$", var.github_repository_id))
    error_message = "github_repository_id must be the numeric repository ID, or empty."
  }
}

variable "github_repository_owner_id" {
  description = "The owning organization's numeric ID (gh api repos/<owner>/<name> --jq .owner.id)."
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^([0-9]+)?$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id must be the numeric owner ID, or empty."
  }
}

variable "github_oidc_provider_arn" {
  description = "An existing IAM OIDC provider for token.actions.githubusercontent.com in this account, to reuse (AWS allows one per URL per account). Empty creates one (decision D2)."
  type        = string
  default     = ""
  validation {
    condition     = var.github_oidc_provider_arn == "" || can(regex("^arn:aws:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_oidc_provider_arn))
    error_message = "github_oidc_provider_arn must be the ARN of the token.actions.githubusercontent.com provider, or empty."
  }
}

variable "image_release_environment" {
  description = "The GitHub environment the release job runs in (decision D1: limited to main, no required reviewer). The founder creates it in the repository settings."
  type        = string
  default     = "image-release"
  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,100}$", var.image_release_environment))
    error_message = "image_release_environment must be a plain environment name."
  }
}

variable "image_release_human_principals" {
  description = "Synthetic staging only (D6): IAM role ARNs in this account whose sessions may assume the release role to run release-image.sh by hand. Empty creates no such trust. Refused in production."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for arn in var.image_release_human_principals : can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$", arn))])
    error_message = "image_release_human_principals must list IAM role ARNs (arn:aws:iam::<account>:role/<name>), no users, wildcards or sessions."
  }
}

variable "image_release_human_require_mfa" {
  description = "D6: require aws:MultiFactorAuthPresent when a listed role assumes the release role. Off by default: a federated session may not carry the key."
  type        = bool
  default     = false
}

locals {
  image_release_github     = var.github_repository_id != ""
  image_release_humans     = length(var.image_release_human_principals) > 0
  image_release_count      = local.api_count == 1 && (local.image_release_github || local.image_release_humans) ? 1 : 0
  image_release_role_name  = "${local.name}-ci-image-release"
  image_release_role_arn   = "arn:aws:iam::${local.audit_account_id}:role/${local.image_release_role_name}"
  github_oidc_provider_arn = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : one(aws_iam_openid_connect_provider.github[*].arn)
}

# No thumbprint: AWS trusts GitHub's OIDC endpoint through its own certificate authorities, and the provider schema makes the list optional.
resource "aws_iam_openid_connect_provider" "github" {
  count          = local.image_release_count == 1 && local.image_release_github && var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Who may become the release role: GitHub's OIDC token for THIS repository (by immutable ID), from ci.yml, on main, in the release environment. Every
# condition is StringEquals: no wildcard branch, environment or workflow. (The keys are the GitHub claims AWS documents as condition keys; read 2026-10-20.)
data "aws_iam_policy_document" "image_release_trust" {
  count = local.image_release_count
  dynamic "statement" {
    for_each = local.image_release_github ? [1] : []
    content {
      sid     = "GitHubReleaseJobOnMainOnly"
      actions = ["sts:AssumeRoleWithWebIdentity"]
      principals {
        type        = "Federated"
        identifiers = [local.github_oidc_provider_arn]
      }
      condition {
        test     = "StringEquals"
        variable = "token.actions.githubusercontent.com:aud"
        values   = ["sts.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "token.actions.githubusercontent.com:repository_id"
        values   = [var.github_repository_id]
      }
      condition {
        test     = "StringEquals"
        variable = "token.actions.githubusercontent.com:repository_owner_id"
        values   = [var.github_repository_owner_id]
      }
      condition {
        test     = "StringEquals"
        variable = "token.actions.githubusercontent.com:ref"
        values   = ["refs/heads/main"]
      }
      condition {
        test     = "StringEquals"
        variable = "token.actions.githubusercontent.com:environment"
        values   = [var.image_release_environment]
      }
      # Assumption A1 (spec.md): GitHub fills job_workflow_ref for a job in a non-reusable workflow with that workflow's own path. If the first real run
      # shows otherwise (CloudTrail AssumeRoleWithWebIdentity), it fails closed and this condition changes to `workflow = "ci"`.
      condition {
        test     = "StringEquals"
        variable = "token.actions.githubusercontent.com:job_workflow_ref"
        values   = ["${var.github_repository}/.github/workflows/ci.yml@refs/heads/main"]
      }
    }
  }
  # D6, synthetic staging only: the listed roles of this account, by exact ARN (the role resource checks the account and refuses production). A session
  # of the release role carries its narrow permissions, so the person can push to the API repository and sign, and nothing else, for at most one hour.
  dynamic "statement" {
    for_each = local.image_release_humans ? [1] : []
    content {
      sid     = "NamedRolesOnSyntheticStaging"
      actions = ["sts:AssumeRole"]
      principals {
        type        = "AWS"
        identifiers = var.image_release_human_principals
      }
      dynamic "condition" {
        for_each = var.image_release_human_require_mfa ? [1] : []
        content {
          test     = "Bool"
          variable = "aws:MultiFactorAuthPresent"
          values   = ["true"]
        }
      }
    }
  }
}

resource "aws_iam_role" "image_release" {
  count                = local.image_release_count
  name                 = local.image_release_role_name
  description          = "Release step: push the scanned API image and sign its digest (INF-03). Assumable by this repository's ci.yml on main in the release environment, and on synthetic staging by the named roles (D6)."
  assume_role_policy   = data.aws_iam_policy_document.image_release_trust[0].json
  max_session_duration = 3600

  lifecycle {
    # D6: a person may become the release role only on synthetic staging, and only from a role of this account. Production signs from CI or not at all.
    precondition {
      condition     = !local.image_release_humans || var.environment != "production"
      error_message = "image_release_human_principals is synthetic staging only (spec 002 D6): production releases only through CI's release job."
    }
    precondition {
      condition     = alltrue([for arn in var.image_release_human_principals : startswith(arn, "arn:aws:iam::${local.audit_account_id}:role/")])
      error_message = "image_release_human_principals must be roles of this stack's account."
    }
  }
}

# What the release role can do: log in to ECR, push to the API repository (and read back what it pushed), and sign with the image key. Nothing else.
data "aws_iam_policy_document" "image_release" {
  count = local.image_release_count
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushToTheApiRepositoryOnly"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.api[0].arn]
  }
  statement {
    sid       = "SignWithTheImageKeyOnly"
    actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
    resources = [aws_kms_key.image_signing[0].arn]
  }
}

resource "aws_iam_role_policy" "image_release" {
  count  = local.image_release_count
  name   = "push-and-sign"
  role   = aws_iam_role.image_release[0].id
  policy = data.aws_iam_policy_document.image_release[0].json
}

# The key policy. Account administration as for every key here, then an explicit DENY: nobody but the release role may sign, so an IAM policy granted
# later cannot add a signer. Changing this policy fires the EncryptionKeyChanged alarm (audit.tf), which covers every KMS key in the account.
data "aws_iam_policy_document" "image_signing_key" {
  count = local.image_release_count
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
      values   = [local.image_release_role_arn]
    }
  }
  statement {
    sid       = "TheReleaseRoleSigns"
    actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.image_release_role_arn]
    }
  }
}

# Asymmetric, signing only. KMS cannot rotate an asymmetric key automatically, so there is deliberately no rotation flag: rotation is a new key, a new
# alias target and re-signing the kept images, annually or at once on suspicion (decision D4).
resource "aws_kms_key" "image_signing" {
  count                    = local.image_release_count
  description              = "${local.name} image signing: CI signs the API image digest it built and scanned (INF-03)"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = local.kms_deletion_days
  policy                   = data.aws_iam_policy_document.image_signing_key[0].json
  # The key policy names the role; KMS refuses a policy whose principal does not exist yet.
  depends_on = [aws_iam_role.image_release]
}

resource "aws_kms_alias" "image_signing" {
  count         = local.image_release_count
  name          = "alias/${local.name}-image-signing"
  target_key_id = aws_kms_key.image_signing[0].key_id
}

output "image_release_role_arn" {
  description = "Set as the repository variable the CI release job reads (slice 2), after the first apply. Null while the release path is off."
  value       = one(aws_iam_role.image_release[*].arn)
}

output "image_signing_key_alias" {
  description = "What cosign signs and verifies with: awskms:///<this alias>. Null while the release path is off."
  value       = one(aws_kms_alias.image_signing[*].name)
}
