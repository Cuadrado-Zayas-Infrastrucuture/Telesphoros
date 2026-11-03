# Run with: terraform test   (from infrastructure/terraform, after `terraform init -backend=false`)
#
# An offline PLAN of this root under each deployment profile (profile.tf), with every provider mocked: no AWS account, no credentials,
# nothing is created. It proves the SHAPE of each profile: what exists, what is switched off, and what is refused. It does NOT prove that AWS
# accepts the plan (limits, quotas, a service the account's plan refuses): that is the first real apply (the FD-7 rehearsal).
#
# The text guards (guard.test.mjs and its siblings) pin the security settings themselves; these runs pin the resource-level consequences.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"*\"}]}"
    }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-2a", "us-east-2b", "us-east-2c"]
    }
  }
}

mock_provider "aws" {
  alias = "backup"
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"*\"}]}"
    }
  }
}

mock_provider "aws" {
  alias = "web_certificate"
}

mock_provider "archive" {}

variables {
  environment            = "staging"
  vpc_id                 = "vpc-0123456789abcdef0"
  private_subnet_ids     = ["subnet-aaaa1111", "subnet-bbbb2222"]
  app_security_group_ids = ["sg-0123456789abcdef0"]
  reports_cors_origins   = ["https://staging.example.test"]
  app_callback_urls      = ["https://staging.example.test/cb"]
  app_logout_urls        = ["https://staging.example.test/out"]
  cognito_domain_prefix  = "profile-test"
  ses_from_email         = "no-reply@example.test"
  alarm_email            = "ops@example.test"
  # A reading, as production requires (database-connections.tf). The runs about the budget itself set their own.
  db_connection_budget = 200
}

run "classic_branding_off_by_default" {
  command = plan
  assert {
    condition     = length(aws_cognito_user_pool_ui_customization.spa) == 0
    error_message = "Branding must not change an existing login until explicitly enabled."
  }
}

run "existing_classic_domain_can_be_branded" {
  command = plan
  variables {
    enable_cognito_classic_branding         = true
    cognito_branding_observed_login_version = 1
  }
  override_resource {
    target = aws_cognito_user_pool_domain.main
    values = { managed_login_version = 1 }
  }
  assert {
    condition     = length(aws_cognito_user_pool_ui_customization.spa) == 1
    error_message = "The opted-in browser client must receive classic branding."
  }
}

run "managed_login_domain_is_not_migrated" {
  command = plan
  variables {
    enable_cognito_classic_branding         = true
    cognito_branding_observed_login_version = 2
  }
  override_resource {
    target = aws_cognito_user_pool_domain.main
    values = { managed_login_version = 2 }
  }
  expect_failures = [aws_cognito_user_pool_ui_customization.spa]
}

run "unverified_domain_is_refused" {
  command = plan
  variables {
    enable_cognito_classic_branding = true
  }
  expect_failures = [aws_cognito_user_pool_ui_customization.spa]
}
