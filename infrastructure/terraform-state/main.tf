terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }
  # Independent local bootstrap state; main's backend is deliberately untouched.
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [local.account_id]
}

locals {
  account_id = try(split(":", var.state_principal_arn)[4], "invalid")
  bucket_arn = "arn:aws:s3:::${var.bucket_name}"
  state_arn  = "${local.bucket_arn}/${var.state_key}"
  lock_arn   = "${local.state_arn}.tflock"
  principal  = { AWS = var.state_principal_arn }
  tags       = { Project = "telesphoros-remastered", Component = "terraform-state", ManagedBy = "terraform" }
}

resource "aws_kms_key" "state" {
  description                        = "Terraform state and lock objects only"
  enable_key_rotation                = true
  deletion_window_in_days            = 30
  bypass_policy_lockout_safety_check = false
  tags                               = local.tags
  # Resource=* in a KMS key policy means THIS key, not every key in the account.
  # https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-overview.html
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "KeyAdministration", Effect = "Allow", Principal = local.principal, Resource = "*"
        Action = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:PutKeyPolicy", "kms:EnableKeyRotation", "kms:DisableKeyRotation", "kms:GetKeyRotationStatus", "kms:UpdateKeyDescription", "kms:TagResource", "kms:UntagResource", "kms:ListResourceTags", "kms:ListKeyPolicies"]
      },
      {
        Sid    = "StateEncryption", Effect = "Allow", Principal = local.principal, Resource = "*"
        Action = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
        Condition = {
          StringEquals = {
            "kms:ViaService"                   = "s3.${var.region}.amazonaws.com"
            "kms:CallerAccount"                = local.account_id
            "kms:EncryptionContext:aws:s3:arn" = [local.state_arn, local.lock_arn]
          }
        }
      }
    ]
  })
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket" "state" {
  bucket        = var.bucket_name
  force_destroy = false
  tags          = local.tags
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.bucket
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.bucket
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.bucket
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.bucket
  rule {
    # Object ARN encryption context is needed to constrain this key to the two paths.
    # https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html
    bucket_key_enabled = false
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket     = aws_s3_bucket.state.bucket
  depends_on = [aws_s3_bucket_versioning.state]
  rule {
    id     = "old-state-and-lock-versions"
    status = "Enabled"
    filter { prefix = var.state_key }
    noncurrent_version_expiration { noncurrent_days = var.noncurrent_retention_days }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket     = aws_s3_bucket.state.bucket
  depends_on = [aws_s3_bucket_public_access_block.state]
  # Separate denies: combining encryption/key mismatches with AND would fail open.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*"
        Resource  = [local.bucket_arn, "${local.bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyOtherPrincipals", Effect = "Deny", Principal = "*", Action = "s3:*"
        Resource  = [local.bucket_arn, "${local.bucket_arn}/*"]
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = var.state_principal_arn } }
      },
      {
        Sid    = "AllowBucketMetadata", Effect = "Allow", Principal = local.principal
        Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = local.bucket_arn
      },
      {
        Sid    = "AllowState", Effect = "Allow", Principal = local.principal
        Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], Resource = local.state_arn
      },
      {
        Sid    = "AllowLock", Effect = "Allow", Principal = local.principal
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = local.lock_arn
      },
      {
        Sid         = "DenyOtherObjects", Effect = "Deny", Principal = "*"
        Action      = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
        NotResource = [local.state_arn, local.lock_arn]
      },
      {
        Sid    = "DenyStateDeletion", Effect = "Deny", Principal = "*"
        Action = ["s3:DeleteObject", "s3:DeleteObjectVersion"], Resource = local.state_arn
      },
      {
        Sid    = "DenyVersionDeletion", Effect = "Deny", Principal = "*"
        Action = "s3:DeleteObjectVersion", Resource = "${local.bucket_arn}/*"
      },
      {
        Sid       = "DenyWrongEncryption", Effect = "Deny", Principal = "*", Action = "s3:PutObject"
        Resource  = [local.state_arn, local.lock_arn]
        Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" } }
      },
      {
        Sid       = "DenyWrongKey", Effect = "Deny", Principal = "*", Action = "s3:PutObject"
        Resource  = [local.state_arn, local.lock_arn]
        Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.state.arn } }
      }
    ]
  })
}
