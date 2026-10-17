# Every run is a plan with a mocked provider; no credentials, AWS calls or real apply.
# Computed values are mocked at plan time, not policy JSON: assertions inspect our real policies.
# https://developer.hashicorp.com/terraform/language/tests/mocking
mock_provider "aws" {
  override_during = plan
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111" }
  }
}

variables {
  region                    = "us-east-1"
  bucket_name               = "telesphoros-synthetic-state-test"
  state_key                 = "staging/terraform.tfstate"
  state_principal_arn       = "arn:aws:iam::123456789012:role/terraform-state-owner"
  noncurrent_retention_days = 90
}

run "private_versioned_encrypted_storage" {
  command = plan
  assert {
    condition     = aws_s3_bucket.state.bucket == var.bucket_name && !aws_s3_bucket.state.force_destroy && aws_kms_key.state.enable_key_rotation && aws_kms_key.state.deletion_window_in_days == 30 && !aws_kms_key.state.bypass_policy_lockout_safety_check
    error_message = "Bucket/key ownership, rotation and deletion protections must remain explicit."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_acls && aws_s3_bucket_public_access_block.state.block_public_policy && aws_s3_bucket_public_access_block.state.ignore_public_acls && aws_s3_bucket_public_access_block.state.restrict_public_buckets && one(aws_s3_bucket_ownership_controls.state.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "Public access and ACLs must be blocked."
  }
  assert {
    condition     = one(aws_s3_bucket_versioning.state.versioning_configuration).status == "Enabled" && one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms" && one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default[0].kms_master_key_id == aws_kms_key.state.arn && !one(aws_s3_bucket_server_side_encryption_configuration.state.rule).bucket_key_enabled
    error_message = "Versioned state uses its own key and object-level encryption context."
  }
  assert {
    condition     = one(aws_s3_bucket_lifecycle_configuration.state.rule).status == "Enabled" && one(one(aws_s3_bucket_lifecycle_configuration.state.rule).filter).prefix == var.state_key && one(one(aws_s3_bucket_lifecycle_configuration.state.rule).noncurrent_version_expiration).noncurrent_days == 90 && length(one(aws_s3_bucket_lifecycle_configuration.state.rule).expiration) == 0
    error_message = "Only old versions expire at the explicitly chosen age; never current state."
  }
  assert {
    condition     = output.backend_config.bucket == var.bucket_name && output.backend_config.key == var.state_key && output.backend_config.region == var.region && output.backend_config.encrypt && output.backend_config.use_lockfile && output.backend_config.kms_key_id == aws_kms_key.state.arn
    error_message = "The future descriptor requires encryption and native locking without wiring a backend."
  }
}

run "exact_state_and_lock_policies" {
  command = plan
  assert {
    condition     = toset(one([for s in jsondecode(aws_kms_key.state.policy).Statement : s if s.Sid == "KeyAdministration"]).Action) == toset(["kms:DescribeKey", "kms:GetKeyPolicy", "kms:PutKeyPolicy", "kms:EnableKeyRotation", "kms:DisableKeyRotation", "kms:GetKeyRotationStatus", "kms:UpdateKeyDescription", "kms:TagResource", "kms:UntagResource", "kms:ListResourceTags", "kms:ListKeyPolicies"])
    error_message = "Key administration cannot grant unconditioned cryptographic actions or wildcard rights."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s.Principal == "*" ? s.Effect == "Deny" : s.Principal.AWS == var.state_principal_arn])
    error_message = "Wildcard principals are only explicit denies, never grants."
  }
  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyInsecureTransport"]).Condition.Bool["aws:SecureTransport"] == "false" && one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyOtherPrincipals"]).Condition.ArnNotEquals["aws:PrincipalArn"] == var.state_principal_arn
    error_message = "Unencrypted transport and other identities must be denied, including implicit IAM grants."
  }
  assert {
    condition     = toset(one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "AllowState"]).Action) == toset(["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]) && one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "AllowState"]).Resource == "arn:aws:s3:::telesphoros-synthetic-state-test/staging/terraform.tfstate" && toset(one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "AllowLock"]).Action) == toset(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]) && one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "AllowLock"]).Resource == "arn:aws:s3:::telesphoros-synthetic-state-test/staging/terraform.tfstate.tflock"
    error_message = "Only the exact state and lock paths are granted; only the temporary lock is deletable."
  }
  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyStateDeletion"]).Effect == "Deny" && one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyStateDeletion"]).Resource == "arn:aws:s3:::telesphoros-synthetic-state-test/staging/terraform.tfstate" && toset(one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyStateDeletion"]).Action) == toset(["s3:DeleteObject", "s3:DeleteObjectVersion"]) && one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyVersionDeletion"]).Action == "s3:DeleteObjectVersion" && one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyVersionDeletion"]).Resource == "arn:aws:s3:::telesphoros-synthetic-state-test/*"
    error_message = "Current state and historical versions cannot be routinely deleted."
  }
  assert {
    condition     = toset(one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyOtherObjects"]).NotResource) == toset(["arn:aws:s3:::telesphoros-synthetic-state-test/staging/terraform.tfstate", "arn:aws:s3:::telesphoros-synthetic-state-test/staging/terraform.tfstate.tflock"]) && one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyWrongEncryption"]).Condition.StringNotEquals["s3:x-amz-server-side-encryption"] == "aws:kms" && one([for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement : s if s.Sid == "DenyWrongKey"]).Condition.StringNotEquals["s3:x-amz-server-side-encryption-aws-kms-key-id"] == aws_kms_key.state.arn
    error_message = "Out-of-scope paths and missing/wrong encryption headers must be denied independently."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_kms_key.state.policy).Statement : s.Principal.AWS == var.state_principal_arn && s.Effect == "Allow"]) && toset(one([for s in jsondecode(aws_kms_key.state.policy).Statement : s if s.Sid == "StateEncryption"]).Action) == toset(["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]) && one([for s in jsondecode(aws_kms_key.state.policy).Statement : s if s.Sid == "StateEncryption"]).Condition.StringEquals["kms:ViaService"] == "s3.us-east-1.amazonaws.com" && one([for s in jsondecode(aws_kms_key.state.policy).Statement : s if s.Sid == "StateEncryption"]).Condition.StringEquals["kms:CallerAccount"] == "123456789012" && toset(one([for s in jsondecode(aws_kms_key.state.policy).Statement : s if s.Sid == "StateEncryption"]).Condition.StringEquals["kms:EncryptionContext:aws:s3:arn"]) == toset(["arn:aws:s3:::telesphoros-synthetic-state-test/staging/terraform.tfstate", "arn:aws:s3:::telesphoros-synthetic-state-test/staging/terraform.tfstate.tflock"])
    error_message = "Key use is bound to the chosen identity, account, S3 Region and exact object contexts."
  }
}

run "accepts_explicit_user_owner" {
  command = plan
  variables { state_principal_arn = "arn:aws:iam::123456789012:user/terraform-owner" }
  assert {
    condition     = alltrue([for s in jsondecode(aws_kms_key.state.policy).Statement : s.Principal.AWS == "arn:aws:iam::123456789012:user/terraform-owner"])
    error_message = "An explicit IAM user is supported as well as an existing role."
  }
}

run "refuses_principal_wildcard" {
  command = plan
  variables { state_principal_arn = "*" }
  expect_failures = [var.state_principal_arn]
}

run "refuses_principal_root" {
  command = plan
  variables { state_principal_arn = "arn:aws:iam::123456789012:root" }
  expect_failures = [var.state_principal_arn]
}

run "refuses_principal_session" {
  command = plan
  variables { state_principal_arn = "arn:aws:sts::123456789012:assumed-role/owner/session" }
  expect_failures = [var.state_principal_arn]
}

run "refuses_principal_newline" {
  command = plan
  variables { state_principal_arn = "arn:aws:iam::123456789012:role/owner\n" }
  expect_failures = [var.state_principal_arn]
}

run "refuses_principal_partition" {
  command = plan
  variables { state_principal_arn = "arn:aws-cn:iam::123456789012:role/owner" }
  expect_failures = [var.state_principal_arn]
}

run "refuses_bucket_public_pattern" {
  command = plan
  variables { bucket_name = "*" }
  expect_failures = [var.bucket_name]
}

run "refuses_bucket_dotted" {
  command = plan
  variables { bucket_name = "my.bucket" }
  expect_failures = [var.bucket_name]
}

run "refuses_bucket_reserved" {
  command = plan
  variables { bucket_name = "amzn-s3-demo-test" }
  expect_failures = [var.bucket_name]
}

run "refuses_bucket_newline" {
  command = plan
  variables { bucket_name = "bucket-name\n" }
  expect_failures = [var.bucket_name]
}

run "refuses_key_wildcard" {
  command = plan
  variables { state_key = "*.tfstate" }
  expect_failures = [var.state_key]
}

run "refuses_key_traversal" {
  command = plan
  variables { state_key = "../state.tfstate" }
  expect_failures = [var.state_key]
}

run "refuses_key_empty_segment" {
  command = plan
  variables { state_key = "state//file.tfstate" }
  expect_failures = [var.state_key]
}

run "refuses_key_lock_path" {
  command = plan
  variables { state_key = "state.tfstate.tflock" }
  expect_failures = [var.state_key]
}

run "refuses_region_missing" {
  command = plan
  variables { region = "" }
  expect_failures = [var.region]
}

run "refuses_region_newline" {
  command = plan
  variables { region = "us-east-1\n" }
  expect_failures = [var.region]
}

run "refuses_retention_zero" {
  command = plan
  variables { noncurrent_retention_days = 0 }
  expect_failures = [var.noncurrent_retention_days]
}

run "refuses_retention_negative" {
  command = plan
  variables { noncurrent_retention_days = -1 }
  expect_failures = [var.noncurrent_retention_days]
}

run "refuses_retention_fraction" {
  command = plan
  variables { noncurrent_retention_days = 1.5 }
  expect_failures = [var.noncurrent_retention_days]
}
