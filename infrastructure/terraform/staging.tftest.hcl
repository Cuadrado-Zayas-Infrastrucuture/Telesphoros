# Run with: terraform test   (from infrastructure/terraform, after `terraform init -backend=false`)
#
# The three offline plans of the FD-7 staged synthetic environment, with the values of synthetic-staging.tfvars.example (staging.guard.test.mjs keeps the two
# in step). Every provider is mocked: no AWS account, no credentials, nothing is created. This proves the SHAPE the review page (docs/ops/staging-plan-review.md)
# tells a person to expect, and that the example's values satisfy the module's own preconditions. It does NOT prove AWS accepts the plan (limits, quotas, the free
# plan, a service the account refuses): that is the first real plan and apply. Policy-input assertions below read the configured statements,
# not the fixed mocked JSON. Saved-plan action checks are exercised separately by scripts/staging/check-plan.test.mjs.

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

# The example's values (synthetic-staging.tfvars.example).
variables {
  environment           = "staging"
  deployment_profile    = "synthetic"
  web_domain            = "staging.telesphoros.app"
  api_domain            = "api.staging.telesphoros.app"
  enable_web_hosting    = true
  enable_api_hosting    = true
  reports_cors_origins  = ["https://app.staging.telesphoros.app"]
  app_callback_urls     = ["https://app.staging.telesphoros.app/auth/callback"]
  app_logout_urls       = ["https://app.staging.telesphoros.app/signed-out"]
  api_cors_origins      = ["https://app.staging.telesphoros.app"]
  cognito_domain_prefix = "telesphoros-staging"
  ses_from_email        = "no-reply@staging.telesphoros.app"
  alarm_email           = "security@example.com"
}

# Plan A: the foundations and the API edge, no web hosting. (There is no plan with both switches off: see the example's header.)
run "plan_a_foundations_and_api_edge" {
  command = plan

  variables {
    enable_web_hosting = false
  }

  assert {
    condition     = output.deployment_profile == "synthetic"
    error_message = "the example selects the synthetic profile"
  }
  assert {
    condition     = aws_sesv2_email_identity.from.email_identity == "staging.telesphoros.app" && aws_cognito_user_pool.main.email_configuration[0].from_email_address == "no-reply@staging.telesphoros.app"
    error_message = "SES must verify the sender's domain (DKIM as staging.telesphoros.app, which DMARC adkim=s accepts) while Cognito still sends from the no-reply address"
  }
  assert {
    condition     = length(aws_vpc.synthetic) == 1 && length(aws_subnet.synthetic) == 2 && length(aws_internet_gateway.synthetic) == 1
    error_message = "the profile creates its own VPC with two subnets and an internet gateway"
  }
  assert {
    condition     = length(aws_lb.api) == 1 && length(aws_acm_certificate.api) == 1 && length(aws_wafv2_web_acl.api) == 1 && length(aws_ecs_cluster.api) == 1
    error_message = "API hosting creates the load balancer, certificate, firewall and cluster"
  }
  assert {
    condition     = output.web_bucket == null && output.web_cloudfront_domain == null
    error_message = "no web hosting in plan A"
  }
  assert {
    condition     = local.api_repository == "arn:aws:ecr:${var.region}:${local.audit_account_id}:repository/none" && one([for statement in data.aws_iam_policy_document.api_execution_common.statement : statement.resources if statement.sid == "PullThisRepositoryOnly"]) == toset([local.api_repository]) && one([for statement in data.aws_iam_policy_document.worker_execution[0].statement : statement.resources if statement.sid == "PullThisRepositoryOnly"]) == toset([local.api_repository])
    error_message = "before an image, existing API and worker execution policies are configured to pull repository/none"
  }
  assert {
    condition     = length(aws_ecs_service.api) == 0 && length(aws_ecs_task_definition.api) == 0 && length(aws_ecs_task_definition.api_migrate) == 0 && length(aws_ecs_task_definition.api_provision) == 0 && length(aws_ecs_service.worker) == 0 && length(aws_ecs_task_definition.worker) == 0
    error_message = "without api_image there are no task definitions and no services"
  }
  assert {
    condition     = length(aws_secretsmanager_secret.api_database_url) == 1 && length(aws_secretsmanager_secret.api_ledger_verifier_url) == 1 && length(aws_secretsmanager_secret.api_migrator_url) == 1 && length(aws_secretsmanager_secret.worker_database_url) == 1 && length(aws_secretsmanager_secret.api_invitation_digest_key) == 1 && length(aws_secretsmanager_secret.api_identifier_digest_key) == 1
    error_message = "the six secret containers exist"
  }
}

# Plan B: web hosting added, still no image.
run "plan_b_with_web_hosting" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket.web) == 1 && length(aws_cloudfront_distribution.web) == 1 && length(aws_acm_certificate.web) == 1
    error_message = "web hosting creates its bucket, certificate and distribution"
  }
  assert {
    condition     = length(aws_ecs_service.api) == 0 && length(aws_ecs_service.worker) == 0
    error_message = "still no services without an image"
  }
  assert {
    condition     = local.api_repository == "arn:aws:ecr:${var.region}:${local.audit_account_id}:repository/none" && length(aws_iam_role_policy.api_execution_service) == 1 && length(aws_iam_role_policy.api_execution_migrate) == 1 && length(aws_iam_role_policy.api_execution_provision) == 1 && length(aws_iam_role_policy.worker_execution) == 1 && length(aws_iam_role_policy.issuer_execution) == 1
    error_message = "the five execution policies already exist in B, before the image changes their pull repository"
  }
}

# The distribution answers the app host, the base domain and www. (The page's content security policy cannot be read at plan time: it embeds the reports bucket's
# address, unknown until apply. staging.guard.test.mjs checks, from the text, that api_domain is api.<web_domain>, which is what that policy allows.)
run "web_aliases" {
  command = plan

  assert {
    condition     = contains(aws_cloudfront_distribution.web[0].aliases, "app.staging.telesphoros.app") && contains(aws_cloudfront_distribution.web[0].aliases, "staging.telesphoros.app") && contains(aws_cloudfront_distribution.web[0].aliases, "www.staging.telesphoros.app")
    error_message = "the distribution answers the app host, the base domain and www under the base domain"
  }
}

# Only the hashed build output is cached at the edge; the shell keeps the managed CachingDisabled policy (web.guard.test.mjs checks the same from the text).
run "web_edge_caching" {
  command = plan

  assert {
    condition     = length(aws_cloudfront_distribution.web[0].ordered_cache_behavior) == 1 && one(aws_cloudfront_distribution.web[0].ordered_cache_behavior).path_pattern == "/assets/*" && one(aws_cloudfront_distribution.web[0].ordered_cache_behavior).cache_policy_id == "658327ea-f89d-4fab-a63d-7e88639e058f" && one(aws_cloudfront_distribution.web[0].ordered_cache_behavior).compress
    error_message = "exactly /assets/* is cached, with the managed CachingOptimized policy and compression"
  }
  assert {
    condition     = one(aws_cloudfront_distribution.web[0].default_cache_behavior).cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    error_message = "everything else, the shell included, stays on the managed CachingDisabled policy"
  }
}

# Plan C: with the image pinned by digest, the task definitions and both services appear.
run "plan_c_with_image" {
  command = plan

  variables {
    api_image = "123456789012.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }

  assert {
    condition     = length(aws_ecs_service.api) == 1 && length(aws_ecs_service.worker) == 1 && length(aws_ecs_task_definition.api) == 1 && length(aws_ecs_task_definition.api_migrate) == 1 && length(aws_ecs_task_definition.api_provision) == 1 && length(aws_ecs_task_definition.worker) == 1
    error_message = "with an image there are two services and four task definitions"
  }
  assert {
    condition     = aws_ecs_service.api[0].desired_count == 1 && aws_ecs_service.worker[0].desired_count == 1
    error_message = "one API task and one worker task"
  }
  assert {
    condition     = local.api_repository == "arn:aws:ecr:us-east-2:123456789012:repository/telesphoros-staging-api" && one([for statement in data.aws_iam_policy_document.api_execution_common.statement : statement.resources if statement.sid == "PullThisRepositoryOnly"]) == toset([local.api_repository]) && one([for statement in data.aws_iam_policy_document.worker_execution[0].statement : statement.resources if statement.sid == "PullThisRepositoryOnly"]) == toset([local.api_repository])
    error_message = "setting api_image changes the configured API and worker pull resources to its exact repository, even though JSON serialization is mocked"
  }
}
