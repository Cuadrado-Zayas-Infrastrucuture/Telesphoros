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

# ------------------------------------------------------------------------------------------------
# The default variables must plan. (Before FD-3 they could not: two IAM policy documents indexed secrets that exist only when API hosting is on.)
# ------------------------------------------------------------------------------------------------
run "default_variables_plan" {
  command = plan

  # INF-03 (specs/002-signed-image-release): the signing key, the GitHub OIDC trust and the release role exist only with API hosting on and the repository IDs set.
  assert {
    condition     = length(aws_kms_key.image_signing) == 0 && length(aws_iam_role.image_release) == 0 && length(aws_iam_openid_connect_provider.github) == 0 && output.image_release_role_arn == null
    error_message = "the signed release path is off by default"
  }

  # INF-12: every exported database log has a declared group (expiring, at the name RDS writes to), and a lost password-change notice alarms.
  assert {
    condition     = toset(keys(aws_cloudwatch_log_group.rds)) == toset(aws_db_instance.main.enabled_cloudwatch_logs_exports) && toset(keys(aws_cloudwatch_log_group.rds)) == toset(["postgresql", "upgrade"])
    error_message = "each exported database log needs exactly one declared log group"
  }
  assert {
    condition     = alltrue([for k, g in aws_cloudwatch_log_group.rds : g.retention_in_days == 365 && g.name == "/aws/rds/instance/${aws_db_instance.main.identifier}/${k}"])
    error_message = "the database log groups must expire after 365 days and sit at the name RDS writes to"
  }
  assert {
    condition     = aws_cloudwatch_log_group.password_notifier.retention_in_days == 90 && aws_cloudwatch_log_metric_filter.password_notice_lost.log_group_name == aws_cloudwatch_log_group.password_notifier.name && aws_cloudwatch_metric_alarm.password_notice_lost.threshold == 1
    error_message = "the notifier keeps 90 days of logs and one lost notice raises the alarm"
  }

  assert {
    condition     = toset(one(aws_s3_bucket_cors_configuration.reports.cors_rule).allowed_methods) == toset(["GET"])
    error_message = "reports CORS must permit signed GET downloads only; uploads use the API"
  }
  assert {
    condition     = toset(one(aws_s3_bucket_cors_configuration.reports.cors_rule).allowed_origins) == toset(var.reports_cors_origins)
    error_message = "reports CORS must use exactly the configured browser origins"
  }

  assert {
    condition     = var.deployment_profile == "production"
    error_message = "the default profile must be production, so a forgotten variable can never select the relaxed one"
  }
  assert {
    condition     = length(aws_ecs_service.api) == 0 && length(aws_lb.api) == 0 && length(aws_ecs_task_definition.api_provision) == 0 && length(data.aws_iam_policy_document.api_provision_task) == 0
    error_message = "API hosting, and with it the provisioning task, is off by default"
  }
  assert {
    condition     = length(aws_ecs_service.worker) == 0 && length(aws_ecs_task_definition.worker) == 0 && length(aws_cloudwatch_metric_alarm.worker_heartbeat_stale) == 0 && length(aws_cloudwatch_metric_alarm.worker_dead_waiting) == 0 && length(aws_cloudwatch_metric_alarm.worker_relay_failing) == 0 && length(aws_cloudwatch_metric_alarm.worker_schedule_failing) == 0 && length(aws_cloudwatch_metric_alarm.worker_outbox_stuck) == 0 && length(aws_cloudwatch_metric_alarm.worker_process_fault) == 0 && length(aws_secretsmanager_secret.worker_database_url) == 0
    error_message = "the worker, with its secret and alarms, is off by default"
  }
  assert {
    condition     = length(aws_ecr_repository.api) == 0 && length(aws_ecr_lifecycle_policy.api) == 0 && output.api_repository_url == null
    error_message = "the image registry is off by default, with the rest of API hosting"
  }
  assert {
    condition     = output.web_bucket == null && output.web_cloudfront_domain == null && output.web_distribution_id == null
    error_message = "web hosting, and with it the bucket, the domain and the distribution id, is off by default"
  }
  assert {
    condition     = output.api_task_subnet_ids == null && output.api_task_assign_public_ip == null && output.api_service_name == null
    error_message = "the one-off task network and the service name are null while API hosting is off"
  }
}

# ------------------------------------------------------------------------------------------------
# Production: two Regions, protected, and a network the operator supplies.
# ------------------------------------------------------------------------------------------------
run "production_shape" {
  command = plan

  variables {
    environment      = "production"
    db_multi_az      = true
    audit_lock_mode  = "COMPLIANCE"
    aws_baa_executed = true
  }

  assert {
    condition     = length(aws_kms_key.backup) == 1 && length(aws_kms_alias.backup) == 1
    error_message = "production keeps the off-site backup key"
  }
  assert {
    condition     = length(aws_s3_bucket.backups) == 1 && length(aws_s3_bucket_object_lock_configuration.backups) == 1 && length(aws_s3_bucket_policy.backups) == 1
    error_message = "production keeps the locked off-site backups bucket and its policy"
  }
  assert {
    condition     = length(aws_db_instance_automated_backups_replication.offsite) == 1 && length(aws_iam_policy.backup_job) == 1
    error_message = "production replicates automated backups off-site and defines the backup job policy"
  }
  assert {
    condition     = one(aws_s3_bucket_object_lock_configuration.backups[0].rule).default_retention[0].days == 14 && one(aws_s3_bucket_object_lock_configuration.audit.rule).default_retention[0].days == 365
    error_message = "production lock periods come from the variables (14 days for backups, 365 for the audit logs)"
  }
  assert {
    condition     = aws_cloudtrail.audit.is_multi_region_trail == true
    error_message = "production's audit trail covers every Region"
  }
  assert {
    condition     = aws_db_instance.main.multi_az == true && aws_db_instance.main.deletion_protection == true && aws_db_instance.main.skip_final_snapshot == false
    error_message = "production's database is Multi-AZ, deletion-protected, and takes a final snapshot"
  }
  assert {
    condition     = aws_db_instance.main.final_snapshot_identifier == "telesphoros-production-final" && aws_db_instance.main.backup_retention_period == 14 && aws_db_instance.main.instance_class == "db.t4g.small"
    error_message = "production keeps its snapshot name, 14-day recovery window and instance class"
  }
  assert {
    condition     = aws_db_instance.main.performance_insights_enabled == true && aws_db_instance.main.publicly_accessible == false
    error_message = "production keeps Performance Insights and no public address"
  }
  assert {
    condition     = aws_s3_bucket.reports.force_destroy == false && aws_s3_bucket.audit.force_destroy == false && aws_s3_bucket.access_logs.force_destroy == false && aws_s3_bucket.backups[0].force_destroy == false
    error_message = "no production bucket can be force-destroyed"
  }
  assert {
    condition     = aws_kms_key.data.deletion_window_in_days == 30 && aws_kms_key.audit.deletion_window_in_days == 30 && aws_kms_key.backup[0].deletion_window_in_days == 30
    error_message = "production keys keep the 30-day deletion window"
  }
  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "ACTIVE"
    error_message = "production's user pool is deletion-protected"
  }
  assert {
    condition     = length(aws_vpc.synthetic) == 0 && length(aws_subnet.synthetic) == 0 && length(aws_internet_gateway.synthetic) == 0 && length(aws_vpc_endpoint.synthetic_s3) == 0
    error_message = "the synthetic network must not exist in production"
  }
  assert {
    condition     = aws_db_subnet_group.main.subnet_ids == toset(["subnet-aaaa1111", "subnet-bbbb2222"])
    error_message = "production's database uses the operator's private subnets"
  }
  assert {
    condition     = output.deployment_profile == "production"
    error_message = "the profile is reported as an output"
  }
  assert {
    condition     = aws_s3_bucket.reports.object_lock_enabled == true && one(aws_s3_bucket_object_lock_configuration.reports.rule).default_retention[0].mode == "GOVERNANCE" && one(aws_s3_bucket_object_lock_configuration.reports.rule).default_retention[0].days == 2190
    error_message = "production locks every report version for six years in GOVERNANCE mode (founder decision 2026-10-19)"
  }
  assert {
    condition     = one(aws_s3_bucket_object_lock_configuration.audit.rule).default_retention[0].mode == "COMPLIANCE"
    error_message = "production audit logs are locked in COMPLIANCE mode"
  }
  assert {
    condition     = length(aws_cloudtrail.audit.advanced_event_selector) == 3 && length(aws_cloudtrail.audit.event_selector) == 0
    error_message = "the trail uses the three advanced selectors (management, reports objects, evidence-log deletes) and no basic selector"
  }
}

run "production_hosting_on" {
  command = plan

  variables {
    environment                = "production"
    db_multi_az                = true
    audit_lock_mode            = "COMPLIANCE"
    aws_baa_executed           = true
    enable_api_hosting         = true
    api_domain                 = "api.example.test"
    public_subnet_ids          = ["subnet-pub1111", "subnet-pub2222"]
    api_image                  = "123456789012.dkr.ecr.us-east-2.amazonaws.com/telesphoros-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    api_cors_origins           = ["https://staging.example.test"]
    api_desired_count          = 2
    github_repository          = "example-org/example-repo"
    github_repository_id       = "100000001"
    github_repository_owner_id = "200000002"
  }

  assert {
    condition     = length(aws_kms_key.image_signing) == 1 && aws_kms_key.image_signing[0].customer_master_key_spec == "ECC_NIST_P256" && aws_kms_key.image_signing[0].key_usage == "SIGN_VERIFY" && aws_kms_key.image_signing[0].deletion_window_in_days == 30
    error_message = "production signs with an ECC P-256 signing key with the production deletion window"
  }
  assert {
    condition     = length(aws_iam_role.image_release) == 1 && length(aws_iam_openid_connect_provider.github) == 1 && aws_iam_openid_connect_provider.github[0].url == "https://token.actions.githubusercontent.com" && toset(aws_iam_openid_connect_provider.github[0].client_id_list) == toset(["sts.amazonaws.com"])
    error_message = "the release role and the GitHub OIDC provider exist when no existing provider is named"
  }
  assert {
    condition = toset(flatten([for c in one(data.aws_iam_policy_document.image_release_trust[0].statement).condition : [for v in c.values : "${c.test} ${c.variable}=${v}"]])) == toset([
      "StringEquals token.actions.githubusercontent.com:aud=sts.amazonaws.com",
      "StringEquals token.actions.githubusercontent.com:repository_id=100000001",
      "StringEquals token.actions.githubusercontent.com:repository_owner_id=200000002",
      "StringEquals token.actions.githubusercontent.com:ref=refs/heads/main",
      "StringEquals token.actions.githubusercontent.com:environment=image-release",
      "StringEquals token.actions.githubusercontent.com:job_workflow_ref=example-org/example-repo/.github/workflows/ci.yml@refs/heads/main",
    ])
    error_message = "the release role trusts only this repository's ci.yml on main in the image-release environment"
  }

  assert {
    condition     = length(aws_ecs_service.api) == 1 && length(aws_ecs_task_definition.api_migrate) == 1 && length(aws_ecs_task_definition.api_provision) == 1
    error_message = "hosting on creates the service, the migration task and the provisioning task"
  }
  assert {
    condition     = length(data.aws_iam_policy_document.api_execution_service) == 1 && length(data.aws_iam_policy_document.api_execution_migrate) == 1
    error_message = "the execution policies exist exactly when hosting is on"
  }
  assert {
    condition     = one(aws_ecs_service.api[0].network_configuration).assign_public_ip == false
    error_message = "production tasks never get a public address"
  }
  assert {
    condition     = one(aws_ecs_service.api[0].network_configuration).subnets == toset(["subnet-aaaa1111", "subnet-bbbb2222"])
    error_message = "production tasks run in the operator's private subnets"
  }
  assert {
    condition     = aws_lb.api[0].subnets == toset(["subnet-pub1111", "subnet-pub2222"]) && aws_lb.api[0].enable_deletion_protection == true
    error_message = "the load balancer uses the supplied public subnets and is deletion-protected in production"
  }
  assert {
    condition     = aws_secretsmanager_secret.api_database_url[0].recovery_window_in_days == 30 && aws_kms_key.api_logs[0].deletion_window_in_days == 30
    error_message = "production keeps the 30-day recovery windows"
  }
  assert {
    condition     = length(aws_ecs_service.worker) == 1 && length(aws_ecs_task_definition.worker) == 1 && length(aws_cloudwatch_metric_alarm.worker_heartbeat_stale) == 1 && length(aws_cloudwatch_metric_alarm.worker_dead_waiting) == 1 && length(aws_cloudwatch_metric_alarm.worker_relay_failing) == 1 && length(aws_cloudwatch_metric_alarm.worker_schedule_failing) == 1 && length(aws_cloudwatch_metric_alarm.worker_outbox_stuck) == 1 && length(aws_cloudwatch_metric_alarm.worker_process_fault) == 1
    error_message = "hosting on creates the worker service, its task definition and its alarms"
  }
  assert {
    condition     = aws_secretsmanager_secret.worker_database_url[0].recovery_window_in_days == 30 && aws_kms_key.worker_logs[0].deletion_window_in_days == 30 && one(aws_ecs_service.worker[0].network_configuration).assign_public_ip == false
    error_message = "the worker follows the profile: production keeps the 30-day windows and gives tasks no public address"
  }
  assert {
    condition     = length(aws_ecr_repository.api) == 1 && aws_ecr_repository.api[0].name == "telesphoros-production-api" && aws_ecr_repository.api[0].force_delete == false
    error_message = "production hosting creates one registry, and a repository that still holds images cannot be deleted"
  }
  assert {
    condition     = aws_ecr_repository.api[0].image_tag_mutability == "IMMUTABLE" && one(aws_ecr_repository.api[0].image_scanning_configuration).scan_on_push == true && one(aws_ecr_repository.api[0].encryption_configuration).encryption_type == "AES256"
    error_message = "the registry has immutable tags, scans on push and is encrypted with the AWS-managed key"
  }
  assert {
    condition     = output.api_task_assign_public_ip == false && output.api_task_subnet_ids == tolist(["subnet-aaaa1111", "subnet-bbbb2222"])
    error_message = "the one-off tasks run in the operator's private subnets without a public address in production"
  }
}

# ------------------------------------------------------------------------------------------------
# Synthetic: one Region, small, destroyable, self-contained network.
# ------------------------------------------------------------------------------------------------
run "synthetic_shape" {
  command = plan

  variables {
    deployment_profile = "synthetic"
    vpc_id             = ""
    private_subnet_ids = []
  }

  # INF-12: every exported database log has a declared group (expiring, at the name RDS writes to), and a lost password-change notice alarms.
  assert {
    condition     = toset(keys(aws_cloudwatch_log_group.rds)) == toset(aws_db_instance.main.enabled_cloudwatch_logs_exports) && toset(keys(aws_cloudwatch_log_group.rds)) == toset(["postgresql", "upgrade"])
    error_message = "each exported database log needs exactly one declared log group"
  }
  assert {
    condition     = alltrue([for k, g in aws_cloudwatch_log_group.rds : g.retention_in_days == 365 && g.name == "/aws/rds/instance/${aws_db_instance.main.identifier}/${k}"])
    error_message = "the database log groups must expire after 365 days and sit at the name RDS writes to"
  }
  assert {
    condition     = aws_cloudwatch_log_group.password_notifier.retention_in_days == 90 && aws_cloudwatch_log_metric_filter.password_notice_lost.log_group_name == aws_cloudwatch_log_group.password_notifier.name && aws_cloudwatch_metric_alarm.password_notice_lost.threshold == 1
    error_message = "the notifier keeps 90 days of logs and one lost notice raises the alarm"
  }

  assert {
    condition     = length(aws_kms_key.backup) == 0 && length(aws_kms_alias.backup) == 0 && length(aws_s3_bucket.backups) == 0 && length(aws_s3_bucket_object_lock_configuration.backups) == 0 && length(aws_s3_bucket_policy.backups) == 0
    error_message = "synthetic has no second-Region key or backups bucket"
  }
  assert {
    condition     = length(aws_db_instance_automated_backups_replication.offsite) == 0 && length(aws_iam_policy.backup_job) == 0 && length(data.aws_iam_policy_document.backup_job) == 0
    error_message = "synthetic has no automated-backup replication and no backup job policy"
  }
  assert {
    condition     = output.backups_bucket == null && output.backup_kms_key_arn == null && output.backup_job_policy_arn == null && output.deployment_profile == "synthetic"
    error_message = "the off-site outputs are null under synthetic"
  }
  assert {
    condition     = aws_cloudtrail.audit.is_multi_region_trail == false
    error_message = "synthetic's audit trail is single-Region"
  }
  assert {
    condition     = aws_db_instance.main.instance_class == "db.t4g.micro" && aws_db_instance.main.multi_az == false && aws_db_instance.main.backup_retention_period == 1
    error_message = "synthetic's database is small, single-AZ, with one day of recovery"
  }
  assert {
    condition     = aws_db_instance.main.deletion_protection == false && aws_db_instance.main.skip_final_snapshot == true && aws_db_instance.main.final_snapshot_identifier == null
    error_message = "synthetic's database can be destroyed without a final snapshot"
  }
  assert {
    condition     = aws_db_instance.main.publicly_accessible == false && aws_db_instance.main.performance_insights_enabled == false
    error_message = "synthetic's database still has no public address"
  }
  assert {
    condition     = aws_s3_bucket.reports.force_destroy == true && aws_s3_bucket.audit.force_destroy == true && aws_s3_bucket.access_logs.force_destroy == true
    error_message = "synthetic's buckets can be emptied on destroy"
  }
  assert {
    condition     = one(aws_s3_bucket_object_lock_configuration.audit.rule).default_retention[0].days == 1 && one(aws_s3_bucket_object_lock_configuration.audit.rule).default_retention[0].mode == "GOVERNANCE"
    error_message = "synthetic's audit lock is one day, GOVERNANCE"
  }
  assert {
    condition     = aws_kms_key.data.deletion_window_in_days == 7 && aws_kms_key.audit.deletion_window_in_days == 7
    error_message = "synthetic keys use the shortest deletion window"
  }
  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "INACTIVE"
    error_message = "synthetic's user pool can be destroyed"
  }
  assert {
    condition     = length(aws_vpc.synthetic) == 1 && length(aws_subnet.synthetic) == 2 && length(aws_internet_gateway.synthetic) == 1 && length(aws_vpc_endpoint.synthetic_s3) == 1
    error_message = "synthetic creates its own VPC, two subnets, an internet gateway and the S3 gateway endpoint"
  }
  assert {
    condition     = aws_subnet.synthetic[0].availability_zone != aws_subnet.synthetic[1].availability_zone
    error_message = "the two subnets must be in different zones: RDS refuses a subnet group inside one"
  }
  assert {
    condition     = one(aws_s3_bucket_object_lock_configuration.reports.rule).default_retention[0].days == 1 && one(aws_s3_bucket_object_lock_configuration.reports.rule).default_retention[0].mode == "GOVERNANCE"
    error_message = "the rehearsal locks report versions for one day only (GOVERNANCE), so it can still be destroyed"
  }
}

run "synthetic_hosting_on" {
  command = plan

  variables {
    deployment_profile = "synthetic"
    vpc_id             = ""
    private_subnet_ids = []
    enable_api_hosting = true
    api_domain         = "api.example.test"
    api_image          = "123456789012.dkr.ecr.us-east-2.amazonaws.com/telesphoros-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    api_cors_origins   = ["https://staging.example.test"]
  }

  assert {
    condition     = length(aws_ecs_task_definition.api_provision) == 1 && length(aws_iam_role.api_provision_task) == 1 && length(aws_iam_role.api_execution_provision) == 1
    error_message = "the provisioning task and its two roles exist under the synthetic profile too"
  }
  assert {
    condition     = one(aws_ecs_service.api[0].network_configuration).assign_public_ip == true
    error_message = "synthetic tasks get a public address (there is no NAT)"
  }
  assert {
    condition     = length(aws_subnet.synthetic) == 2 && length(aws_route_table_association.synthetic) == 2 && length(aws_route.synthetic_internet) == 1
    error_message = "the created subnets are routed to the internet gateway (their ids are only known after apply, so the service's subnet set cannot be compared here)"
  }
  assert {
    condition     = aws_secretsmanager_secret.api_database_url[0].recovery_window_in_days == 0 && aws_secretsmanager_secret.api_migrator_url[0].recovery_window_in_days == 0 && aws_secretsmanager_secret.api_ledger_verifier_url[0].recovery_window_in_days == 0
    error_message = "synthetic secrets are deleted at once, so a re-apply does not collide with a pending deletion"
  }
  assert {
    condition     = aws_kms_key.api_logs[0].deletion_window_in_days == 7
    error_message = "synthetic's log key uses the shortest deletion window"
  }
  assert {
    condition     = length(aws_ecs_service.worker) == 1 && aws_secretsmanager_secret.worker_database_url[0].recovery_window_in_days == 0 && one(aws_ecs_service.worker[0].network_configuration).assign_public_ip == true
    error_message = "the worker follows the synthetic profile: its secret is deleted at once and its tasks get a public address"
  }
  assert {
    condition     = length(aws_ecr_repository.api) == 1 && aws_ecr_repository.api[0].force_delete == true && aws_ecr_repository.api[0].image_tag_mutability == "IMMUTABLE"
    error_message = "the synthetic registry can be destroyed with images in it, and its tags are still immutable"
  }
  assert {
    condition     = output.api_task_assign_public_ip == true && output.api_service_name == "telesphoros-staging-api"
    error_message = "the one-off tasks are told to take a public address under the synthetic profile (no NAT), and the service name is the documented one"
  }
}

# A supplied network under synthetic is used as given: no VPC is created and the tasks get no public address.
run "synthetic_with_own_network" {
  command = plan

  variables {
    deployment_profile = "synthetic"
    enable_api_hosting = true
    api_domain         = "api.example.test"
    public_subnet_ids  = ["subnet-pub1111", "subnet-pub2222"]
    api_image          = "123456789012.dkr.ecr.us-east-2.amazonaws.com/telesphoros-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    api_cors_origins   = ["https://staging.example.test"]
  }

  assert {
    condition     = length(aws_vpc.synthetic) == 0 && one(aws_ecs_service.api[0].network_configuration).assign_public_ip == false
    error_message = "a supplied network is used as given and the tasks stay private"
  }
}

# ------------------------------------------------------------------------------------------------
# Refusals.
# ------------------------------------------------------------------------------------------------
run "refuses_synthetic_for_production" {
  command = plan

  variables {
    deployment_profile = "synthetic"
    environment        = "production"
    db_multi_az        = true
  }

  expect_failures = [terraform_data.profile]
}

run "refuses_a_compliance_lock_under_synthetic" {
  command = plan

  variables {
    deployment_profile = "synthetic"
    audit_lock_mode    = "COMPLIANCE"
  }

  expect_failures = [terraform_data.profile]
}

run "refuses_production_without_a_network" {
  command = plan

  variables {
    vpc_id             = ""
    private_subnet_ids = []
  }

  expect_failures = [terraform_data.profile]
}

run "refuses_a_supplied_vpc_without_subnets" {
  command = plan

  variables {
    deployment_profile = "synthetic"
    private_subnet_ids = []
  }

  expect_failures = [terraform_data.profile]
}

run "refuses_an_unknown_profile" {
  command = plan

  variables {
    deployment_profile = "rehearsal"
  }

  expect_failures = [var.deployment_profile]
}

run "refuses_production_without_multi_az" {
  command = plan

  variables {
    environment      = "production"
    db_multi_az      = false
    audit_lock_mode  = "COMPLIANCE"
    aws_baa_executed = true
  }

  expect_failures = [aws_db_instance.main]
}

run "refuses_production_without_deletion_protection" {
  command = plan

  variables {
    environment            = "production"
    db_multi_az            = true
    audit_lock_mode        = "COMPLIANCE"
    aws_baa_executed       = true
    db_deletion_protection = false
  }

  expect_failures = [aws_db_instance.main]
}

run "refuses_production_with_a_governance_audit_lock" {
  command = plan

  variables {
    environment      = "production"
    db_multi_az      = true
    aws_baa_executed = true
  }

  expect_failures = [terraform_data.profile]
}

run "refuses_production_without_an_executed_baa" {
  command = plan

  variables {
    environment     = "production"
    db_multi_az     = true
    audit_lock_mode = "COMPLIANCE"
  }

  expect_failures = [terraform_data.profile]
}

run "refuses_production_with_a_backup_window_under_a_week" {
  command = plan

  variables {
    environment              = "production"
    db_multi_az              = true
    audit_lock_mode          = "COMPLIANCE"
    aws_baa_executed         = true
    db_backup_retention_days = 6
  }

  expect_failures = [aws_db_instance.main]
}

run "refuses_a_localhost_callback_in_production" {
  command = plan

  variables {
    environment       = "production"
    db_multi_az       = true
    audit_lock_mode   = "COMPLIANCE"
    aws_baa_executed  = true
    app_callback_urls = ["http://localhost:5173/auth/callback"]
  }

  expect_failures = [terraform_data.profile]
}

run "refuses_a_lookalike_localhost_callback" {
  command = plan

  variables {
    app_callback_urls = ["http://localhost.attacker.example/auth/callback"]
  }

  expect_failures = [var.app_callback_urls]
}

run "refuses_a_callback_with_userinfo" {
  command = plan

  variables {
    app_callback_urls = ["https://staging.example.test@attacker.example/auth/callback"]
  }

  expect_failures = [var.app_callback_urls]
}

run "refuses_a_lookalike_localhost_logout" {
  command = plan

  variables {
    app_logout_urls = ["http://localhost.attacker.example/signed-out"]
  }

  expect_failures = [var.app_logout_urls]
}

# Control: outside production a developer may still sign in through the local frontend.
run "allows_a_localhost_callback_outside_production" {
  command = plan

  variables {
    app_callback_urls = ["http://localhost:5173/auth/callback"]
    app_logout_urls   = ["http://localhost:5173/signed-out"]
  }

  assert {
    condition     = contains(aws_cognito_user_pool_client.spa.callback_urls, "http://localhost:5173/auth/callback")
    error_message = "staging accepts an exact localhost callback"
  }
}

run "refuses_a_report_lock_below_six_years" {
  command = plan

  variables {
    reports_lock_days = 2189
  }

  expect_failures = [var.reports_lock_days]
}

run "refuse_reports_cors_wildcard" {
  command = plan
  variables {
    reports_cors_origins = ["https://*.example.test"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuse_reports_cors_path" {
  command = plan
  variables {
    reports_cors_origins = ["https://app.example.test/reports"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuse_reports_cors_http" {
  command = plan
  variables {
    reports_cors_origins = ["http://app.example.test"]
  }
  expect_failures = [var.reports_cors_origins]
}

# Origin regression corpus: exercise native Terraform validation, including control characters.
# Every run plans with the mocked providers above; approved origins must remain exact and GET-only.
run "refuses_reports_cors_origin_empty_list" {
  command = plan
  variables {
    reports_cors_origins = []
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_http_scheme" {
  command = plan
  variables {
    reports_cors_origins = ["http://app.example.test"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_wildcard_host" {
  command = plan
  variables {
    reports_cors_origins = ["https://*.example.test"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_path" {
  command = plan
  variables {
    reports_cors_origins = ["https://app.example.test/path"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_query" {
  command = plan
  variables {
    reports_cors_origins = ["https://app.example.test?x=1"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_fragment" {
  command = plan
  variables {
    reports_cors_origins = ["https://app.example.test#x"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_userinfo" {
  command = plan
  variables {
    reports_cors_origins = ["https://synthetic@app.example.test"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_trailing_newline" {
  command = plan
  variables {
    reports_cors_origins = ["https://app.example.test\n"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_header_injection" {
  command = plan
  variables {
    reports_cors_origins = ["https://app.example.test\r\nX:y"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_backslash_host" {
  command = plan
  variables {
    reports_cors_origins = ["https://app.example.test\\evil.invalid"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "refuses_reports_cors_origin_encoded_separator" {
  command = plan
  variables {
    reports_cors_origins = ["https://app.example.test%2f.evil.invalid"]
  }
  expect_failures = [var.reports_cors_origins]
}

run "preserves_reports_cors_exact_https_origin" {
  command = plan
  variables {
    reports_cors_origins = ["https://app.example.test"]
  }
  assert {
    condition     = toset(one(aws_s3_bucket_cors_configuration.reports.cors_rule).allowed_origins) == toset(var.reports_cors_origins) && toset(one(aws_s3_bucket_cors_configuration.reports.cors_rule).allowed_methods) == toset(["GET"])
    error_message = "Exact approved origins and GET-only contract must survive planning"
  }
}

run "preserves_reports_cors_exact_https_origin_with_port" {
  command = plan
  variables {
    reports_cors_origins = ["https://api-1.example.test:8443"]
  }
  assert {
    condition     = toset(one(aws_s3_bucket_cors_configuration.reports.cors_rule).allowed_origins) == toset(var.reports_cors_origins) && toset(one(aws_s3_bucket_cors_configuration.reports.cors_rule).allowed_methods) == toset(["GET"])
    error_message = "Exact approved origins and GET-only contract must survive planning"
  }
}

# ------------------------------------------------------------------------------------------------
# INF-03: an existing GitHub OIDC provider is reused, never duplicated (D2); half a configuration and production without the signed path are refused.
# ------------------------------------------------------------------------------------------------
run "image_release_reuses_an_existing_oidc_provider" {
  command = plan

  variables {
    deployment_profile         = "synthetic"
    vpc_id                     = ""
    private_subnet_ids         = []
    enable_api_hosting         = true
    api_domain                 = "api.example.test"
    api_cors_origins           = ["https://staging.example.test"]
    github_oidc_provider_arn   = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    github_repository          = "example-org/example-repo"
    github_repository_id       = "100000001"
    github_repository_owner_id = "200000002"
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0 && one(one(data.aws_iam_policy_document.image_release_trust[0].statement).principals).identifiers == toset(["arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"])
    error_message = "a named provider is trusted and no second one is created"
  }
  assert {
    condition     = length(aws_kms_key.image_signing) == 1 && aws_kms_key.image_signing[0].deletion_window_in_days == 7
    error_message = "the synthetic rehearsal gets the key with the short deletion window"
  }
}

run "refuses_half_a_github_repository_configuration" {
  command = plan

  variables {
    deployment_profile   = "synthetic"
    vpc_id               = ""
    private_subnet_ids   = []
    enable_api_hosting   = true
    api_domain           = "api.example.test"
    api_cors_origins     = ["https://staging.example.test"]
    github_repository_id = "100000001"
  }

  expect_failures = [aws_ecr_repository.api]
}

run "refuses_production_hosting_without_the_signed_release_path" {
  command = plan

  variables {
    environment        = "production"
    db_multi_az        = true
    audit_lock_mode    = "COMPLIANCE"
    aws_baa_executed   = true
    enable_api_hosting = true
    api_domain         = "api.example.test"
    public_subnet_ids  = ["subnet-pub1111", "subnet-pub2222"]
    api_cors_origins   = ["https://staging.example.test"]
  }

  expect_failures = [aws_ecr_repository.api]
}

# ------------------------------------------------------------------------------------------------
# The database connection budget (database-connections.tf): every hosted service at its largest count must fit what the instance accepts.
# ------------------------------------------------------------------------------------------------
run "connection_budget_counts_every_pool" {
  command = plan

  variables {
    environment                = "production"
    db_multi_az                = true
    audit_lock_mode            = "COMPLIANCE"
    aws_baa_executed           = true
    enable_api_hosting         = true
    api_domain                 = "api.example.test"
    public_subnet_ids          = ["subnet-pub1111", "subnet-pub2222"]
    api_image                  = "123456789012.dkr.ecr.us-east-2.amazonaws.com/telesphoros-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    api_cors_origins           = ["https://staging.example.test"]
    github_repository          = "example-org/example-repo"
    github_repository_id       = "100000001"
    github_repository_owner_id = "200000002"
    api_desired_count          = 3
    api_db_pool_max            = 5
    worker_desired_count       = 2
    enable_issuer              = true
    issuer_desired_count       = 2
    db_connection_budget       = 100
  }

  assert {
    # 3 API tasks x (5 + 3 verifier) + 2 workers x (4 + 3) + 2 issuers x 4 + 1 migration task
    condition     = output.db_connection_demand.demand == 3 * (5 + 3) + 2 * (4 + 3) + 2 * 4 + 1 && output.db_connection_demand.budget == 100 && !output.db_connection_demand.budget_is_estimate
    error_message = "the demand adds every pool at its largest count, and a given budget is not an estimate"
  }
}

run "connection_budget_refuses_more_than_it_allows" {
  command = plan

  variables {
    environment                = "production"
    db_multi_az                = true
    audit_lock_mode            = "COMPLIANCE"
    aws_baa_executed           = true
    enable_api_hosting         = true
    api_domain                 = "api.example.test"
    public_subnet_ids          = ["subnet-pub1111", "subnet-pub2222"]
    api_image                  = "123456789012.dkr.ecr.us-east-2.amazonaws.com/telesphoros-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    api_cors_origins           = ["https://staging.example.test"]
    github_repository          = "example-org/example-repo"
    github_repository_id       = "100000001"
    github_repository_owner_id = "200000002"
    api_desired_count          = 10
    db_connection_budget       = 100
  }

  expect_failures = [aws_db_instance.main]
}

run "connection_budget_estimate_off_production" {
  command = plan

  variables {
    deployment_profile   = "synthetic"
    enable_api_hosting   = true
    api_domain           = "api.example.test"
    public_subnet_ids    = ["subnet-pub1111", "subnet-pub2222"]
    api_image            = "123456789012.dkr.ecr.us-east-2.amazonaws.com/telesphoros-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    api_cors_origins     = ["https://staging.example.test"]
    db_connection_budget = null
  }

  assert {
    condition     = output.db_connection_demand.budget == 68 && output.db_connection_demand.budget_is_estimate && output.db_connection_demand.demand == 1 * (10 + 3) + 1 * (4 + 3) + 1
    error_message = "a synthetic plan without a reading uses the db.t4g.micro estimate, labelled as one, and counts the default pools"
  }
}

run "connection_budget_estimate_refused_in_production" {
  command = plan

  variables {
    environment          = "production"
    db_multi_az          = true
    audit_lock_mode      = "COMPLIANCE"
    aws_baa_executed     = true
    db_connection_budget = null
  }

  expect_failures = [aws_db_instance.main]
}

run "connection_budget_needs_a_reading_for_an_unlisted_class" {
  command = plan

  variables {
    db_instance_class    = "db.r7g.large"
    db_connection_budget = null
  }

  expect_failures = [aws_db_instance.main]
}
