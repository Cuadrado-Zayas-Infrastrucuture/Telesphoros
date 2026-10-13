# F3b: the API's compute (cluster, tasks, roles, secret containers, log group, alarms). NOT APPLIED. Off by default.
# It sits behind the edge in api-edge.tf (same switch, enable_api_hosting). The cluster, roles, secret containers, log group and the ledger alarm
# exist as soon as the switch is on; the task definitions and the service also need `api_image`, so the foundations can be applied, the secrets
# filled and the image built (F4) before anything runs. Plan: docs/design/plans/f3-api-hosting.md. Design: docs/ops/api-hosting.md.

variable "api_image" {
  description = "The API image, pinned by digest (registry/repository@sha256:...). Empty creates the foundations without the task definitions and the service. A tag is refused: a deployment is exactly one reviewed artifact."
  type        = string
  default     = ""
  validation {
    condition     = var.api_image == "" || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be an ECR image pinned by digest: <account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<64 hex>."
  }
}

variable "api_cors_origins" {
  description = "Browser origins the API answers, e.g. [\"https://app.telesphoros.app\"] (staging: the Vercel staging address). Every origin must be https."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for o in var.api_cors_origins : startswith(o, "https://")])
    error_message = "Every api_cors_origins entry must start with https://."
  }
}

variable "api_desired_count" {
  description = "How many API tasks run. Production needs at least two (one per zone)."
  type        = number
  default     = 1
  validation {
    condition     = var.api_desired_count >= 1 && var.api_desired_count <= 10
    error_message = "api_desired_count must be between 1 and 10."
  }
}

variable "api_cpu" {
  description = "Fargate CPU units per task. A first guess: measure in staging."
  type        = number
  default     = 512
  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.api_cpu)
    error_message = "api_cpu must be 256, 512, 1024, 2048 or 4096."
  }
}

variable "api_memory" {
  description = "Fargate memory in MiB per task. It must be a size Fargate allows for api_cpu. A first guess: measure in staging."
  type        = number
  default     = 1024
  validation {
    condition     = var.api_memory >= 512 && var.api_memory <= 30720
    error_message = "api_memory must be between 512 and 30720."
  }
}

variable "api_log_retention_days" {
  description = "How long the API's own logs are kept. The audit trail (audit.tf) is the long-term record; this is operational. Never below 90."
  type        = number
  default     = 365
  validation {
    condition     = var.api_log_retention_days >= 90
    error_message = "api_log_retention_days must be at least 90."
  }
}

locals {
  api_service_count = var.enable_api_hosting && var.api_image != "" ? 1 : 0
  api_container     = "api"
  api_log_group     = "/ecs/${local.name}-api"
  api_metrics       = "${local.name}/Api"
  api_user          = "10001"

  # ECR repository from the image reference, so the execution role can pull exactly that repository and nothing else.
  api_image_parts = try(regex("^([0-9]{12})\\.dkr\\.ecr\\.([a-z0-9-]+)\\.amazonaws\\.com/([a-z0-9._/-]+)@sha256:([0-9a-f]{64})$", var.api_image), null)
  api_repository  = local.api_image_parts == null ? "arn:aws:ecr:${var.region}:${local.audit_account_id}:repository/none" : "arn:aws:ecr:${local.api_image_parts[1]}:${local.api_image_parts[0]}:repository/${local.api_image_parts[2]}"
  api_build       = local.api_image_parts == null ? "none" : "sha256-${substr(local.api_image_parts[3], 0, 12)}"

  # Everything the production start-up demands (config/env.ts), and nothing it refuses (no pipeline, no development overrides, no shared secret).
  api_environment = {
    NODE_ENV                          = "production"
    PORT                              = tostring(local.api_port)
    AUTH_VERIFIER                     = "cognito"
    COGNITO_REGION                    = var.region
    COGNITO_USER_POOL_ID              = aws_cognito_user_pool.main.id
    COGNITO_APP_CLIENT_ID             = aws_cognito_user_pool_client.spa.id
    STORAGE_DRIVER                    = "postgres"
    OBJECT_STORAGE_DRIVER             = "s3"
    REPORTS_BUCKET                    = aws_s3_bucket.reports.bucket
    AWS_REGION                        = var.region
    DATABASE_SSL                      = "require"
    CORS_ALLOWED_ORIGINS              = join(",", var.api_cors_origins)
    RATE_LIMIT_ENABLED                = "true"
    TRUST_PROXY_HOPS                  = "1"
    BUILD_VERSION                     = local.api_build
    LEDGER_FULL_VERIFY_INTERVAL_HOURS = "24"
  }
}

# ------------------------------------------------------------------------------------------------
# The API's own logs: a log group with its own key (not the data key and not the audit key).
# ------------------------------------------------------------------------------------------------
data "aws_iam_policy_document" "api_logs_key" {
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
    sid       = "CloudWatchLogsEncryptTheApiLogGroup"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.api_log_group}"]
    }
  }
}

resource "aws_kms_key" "api_logs" {
  count                   = local.api_count
  description             = "${local.name} API logs"
  enable_key_rotation     = true
  deletion_window_in_days = local.kms_deletion_days
  policy                  = data.aws_iam_policy_document.api_logs_key.json
}

resource "aws_kms_alias" "api_logs" {
  count         = local.api_count
  name          = "alias/${local.name}-api-logs"
  target_key_id = aws_kms_key.api_logs[0].key_id
}

resource "aws_cloudwatch_log_group" "api" {
  count             = local.api_count
  name              = local.api_log_group
  retention_in_days = var.api_log_retention_days
  kms_key_id        = aws_kms_key.api_logs[0].arn
}

# ------------------------------------------------------------------------------------------------
# Secret CONTAINERS only. Terraform never sees a value: people put them in by hand once the logins exist
# (docs/ops/api-hosting.md, "The database logins"). A secret version here would put the value in state.
# ------------------------------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "api_database_url" {
  count       = local.api_count
  name        = "${local.name}/api/database-url"
  description = "DATABASE_URL: the application login (member of telesphoros_app only). Value set by hand."
  kms_key_id  = aws_kms_key.data.arn

  recovery_window_in_days = local.secret_recovery_days
}

resource "aws_secretsmanager_secret" "api_ledger_verifier_url" {
  count       = local.api_count
  name        = "${local.name}/api/ledger-verifier-database-url"
  description = "LEDGER_VERIFIER_DATABASE_URL: the verifier login (member of telesphoros_ledger_verifier only, never telesphoros_app). Value set by hand."
  kms_key_id  = aws_kms_key.data.arn

  recovery_window_in_days = local.secret_recovery_days
}

resource "aws_secretsmanager_secret" "api_invitation_digest_key" {
  count       = local.api_count
  name        = "${local.name}/api/invitation-digest-key"
  description = "INVITATION_DIGEST_KEY: 64 hex characters (openssl rand -hex 32) keying the digest of an invited person's address. Value set by hand; losing it makes pending invitations unfulfillable (they expire in 14 days)."
  kms_key_id  = aws_kms_key.data.arn

  recovery_window_in_days = local.secret_recovery_days
}

resource "aws_secretsmanager_secret" "api_migrator_url" {
  count       = local.api_count
  name        = "${local.name}/api/migrator-database-url"
  description = "DATABASE_MIGRATOR_URL: the table owner, used only by the one-off migration task. Value set by hand."
  kms_key_id  = aws_kms_key.data.arn

  recovery_window_in_days = local.secret_recovery_days
}

# ------------------------------------------------------------------------------------------------
# Roles. The TASK role is the application's own identity (the report-file policy from iam.tf, nothing else). Two EXECUTION roles let ECS start a
# task: the service's can read the three runtime secrets, the migration task's can read only the migrator secret. Neither is the application's identity.
# ------------------------------------------------------------------------------------------------
data "aws_iam_policy_document" "api_ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.audit_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.region}:${local.audit_account_id}:*"]
    }
  }
}

resource "aws_iam_role" "api_task" {
  count              = local.api_count
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "api_task_runtime" {
  count      = local.api_count
  role       = aws_iam_role.api_task[0].name
  policy_arn = aws_iam_policy.app_runtime.arn
}

data "aws_iam_policy_document" "api_execution_common" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "PullThisRepositoryOnly"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [local.api_repository]
  }
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.api_log_group}:*"]
  }
}

data "aws_iam_policy_document" "api_execution_service" {
  count                   = local.api_count
  source_policy_documents = [data.aws_iam_policy_document.api_execution_common.json]
  statement {
    sid       = "ReadTheRuntimeSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_invitation_digest_key[0].arn]
  }
  statement {
    sid       = "DecryptSecretsThroughSecretsManager"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "api_execution_migrate" {
  count                   = local.api_count
  source_policy_documents = [data.aws_iam_policy_document.api_execution_common.json]
  statement {
    sid       = "ReadTheMigratorSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.api_migrator_url[0].arn]
  }
  statement {
    sid       = "DecryptSecretsThroughSecretsManager"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

# The one-off provisioning task (db provision-logins). Two identities, as for every task here, and neither is the application's:
#  - the EXECUTION role starts the task and injects the database administrator's credentials from the RDS-managed secret (username and password only);
#  - the TASK role is what the command runs as: it can read and write exactly the three connection-string secrets, and it can NOT read the administrator secret.
data "aws_iam_policy_document" "api_execution_provision" {
  count                   = local.api_count
  source_policy_documents = [data.aws_iam_policy_document.api_execution_common.json]
  statement {
    sid       = "ReadTheAdministratorSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }
  statement {
    sid       = "DecryptSecretsThroughSecretsManager"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "api_provision_task" {
  count = local.api_count
  statement {
    sid       = "ReadAndWriteTheThreeConnectionStrings"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
    resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn]
  }
  statement {
    sid       = "UseTheDataKeyThroughSecretsManager"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_execution_provision" {
  count              = local.api_count
  name               = "${local.name}-api-provision-exec"
  assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json
}

resource "aws_iam_role_policy" "api_execution_provision" {
  count  = local.api_count
  name   = "start-the-provisioning"
  role   = aws_iam_role.api_execution_provision[0].id
  policy = data.aws_iam_policy_document.api_execution_provision[0].json
}

resource "aws_iam_role" "api_provision_task" {
  count              = local.api_count
  name               = "${local.name}-api-provision-task"
  assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json
}

resource "aws_iam_role_policy" "api_provision_task" {
  count  = local.api_count
  name   = "write-the-connection-strings"
  role   = aws_iam_role.api_provision_task[0].id
  policy = data.aws_iam_policy_document.api_provision_task[0].json
}

resource "aws_iam_role" "api_execution_service" {
  count              = local.api_count
  name               = "${local.name}-api-exec"
  assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json
}

resource "aws_iam_role_policy" "api_execution_service" {
  count  = local.api_count
  name   = "start-the-service"
  role   = aws_iam_role.api_execution_service[0].id
  policy = data.aws_iam_policy_document.api_execution_service[0].json
}

resource "aws_iam_role" "api_execution_migrate" {
  count              = local.api_count
  name               = "${local.name}-api-migrate-exec"
  assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json
}

resource "aws_iam_role_policy" "api_execution_migrate" {
  count  = local.api_count
  name   = "start-the-migration"
  role   = aws_iam_role.api_execution_migrate[0].id
  policy = data.aws_iam_policy_document.api_execution_migrate[0].json
}

# ------------------------------------------------------------------------------------------------
# Cluster, task definitions, service
# ------------------------------------------------------------------------------------------------
resource "aws_ecs_cluster" "api" {
  count = local.api_count
  name  = "${local.name}-api"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "api" {
  count                    = local.api_service_count
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.api_execution_service[0].arn
  task_role_arn            = aws_iam_role.api_task[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                   = local.api_container
      image                  = var.api_image
      essential              = true
      user                   = local.api_user
      readonlyRootFilesystem = true
      stopTimeout            = 30
      portMappings           = [{ containerPort = local.api_port, protocol = "tcp" }]
      environment            = [for name, value in local.api_environment : { name = name, value = value }]
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_database_url[0].arn },
        { name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },
        { name = "INVITATION_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_invitation_digest_key[0].arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api[0].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "api"
        }
      }
    }
  ])

  lifecycle {
    precondition {
      condition     = length(var.api_cors_origins) >= 1
      error_message = "Set api_cors_origins: the API must name the origins it answers."
    }
  }
}

# One-off: run by a person (or the deployment pipeline) before a release, never as a service. It uses the table owner's login, which the service never holds.
resource "aws_ecs_task_definition" "api_migrate" {
  count                    = local.api_service_count
  family                   = "${local.name}-api-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.api_execution_migrate[0].arn
  # No task role: the migration reaches the database only, not S3 or anything else in the account.

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                   = "migrate"
      image                  = var.api_image
      essential              = true
      user                   = local.api_user
      readonlyRootFilesystem = true
      command                = ["node", "dist/db/cli.js", "migrate", "up"]
      # TLS is chosen only by this setting; the connection string carries no TLS parameters (apps/backend/src/db/tls.ts).
      environment = [{ name = "DATABASE_SSL", value = "require" }]
      secrets     = [{ name = "DATABASE_MIGRATOR_URL", valueFrom = aws_secretsmanager_secret.api_migrator_url[0].arn }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api[0].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "migrate"
        }
      }
    }
  ])
}

# One-off, run by a person before the first migration and again after it (docs/ops/api-hosting.md): creates the three database logins with generated passwords and
# writes their connection strings into the three secrets. The administrator's credentials come from the RDS-managed secret through the execution role; no password
# is typed, shown or kept in Terraform state. The connection strings it writes carry no TLS parameters (apps/backend/src/db/tls.ts).
resource "aws_ecs_task_definition" "api_provision" {
  count                    = local.api_service_count
  family                   = "${local.name}-api-provision"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.api_execution_provision[0].arn
  task_role_arn            = aws_iam_role.api_provision_task[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                   = "provision"
      image                  = var.api_image
      essential              = true
      user                   = local.api_user
      readonlyRootFilesystem = true
      command                = ["node", "dist/db/cli.js", "provision-logins"]
      environment = [
        { name = "DATABASE_SSL", value = "require" },
        { name = "DATABASE_HOST", value = aws_db_instance.main.address },
        { name = "DATABASE_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DATABASE_NAME", value = aws_db_instance.main.db_name },
        { name = "AWS_REGION", value = var.region },
        { name = "PROVISION_SECRET_APP", value = aws_secretsmanager_secret.api_database_url[0].arn },
        { name = "PROVISION_SECRET_VERIFIER", value = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },
        { name = "PROVISION_SECRET_MIGRATOR", value = aws_secretsmanager_secret.api_migrator_url[0].arn },
      ]
      secrets = [
        { name = "PROVISION_ADMIN_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
        { name = "PROVISION_ADMIN_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api[0].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "provision"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "api" {
  count                              = local.api_service_count
  name                               = "${local.name}-api"
  cluster                            = aws_ecs_cluster.api[0].id
  task_definition                    = aws_ecs_task_definition.api[0].arn
  desired_count                      = var.api_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  enable_execute_command             = false
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.data_subnet_ids
    security_groups  = [aws_security_group.api_tasks[0].id]
    assign_public_ip = local.tasks_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api[0].arn
    container_name   = local.api_container
    container_port   = local.api_port
  }

  depends_on = [aws_lb_listener_rule.api_forward]

  lifecycle {
    precondition {
      condition     = var.environment != "production" || var.api_desired_count >= 2
      error_message = "Production runs at least two API tasks (api_desired_count >= 2)."
    }
  }
}

# ------------------------------------------------------------------------------------------------
# Alarms, into the audit topic (audit.tf) so one confirmed email address hears everything.
# ------------------------------------------------------------------------------------------------
# The record log failed a verification check. The application writes this line as JSON with a top-level `event` field (ledger-monitor.ts);
# a test keeps the pattern and the application's literal in agreement.
resource "aws_cloudwatch_log_metric_filter" "api_ledger_compromised" {
  count          = local.api_count
  name           = "${local.name}-api-ledger-compromised"
  log_group_name = aws_cloudwatch_log_group.api[0].name
  pattern        = "{ $.event = \"ledger-compromised\" }"
  metric_transformation {
    name      = "LedgerCompromised"
    namespace = local.api_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_ledger_compromised" {
  count               = local.api_count
  alarm_name          = "${local.name}-api-ledger-compromised"
  alarm_description   = "The record log failed a verification check. That instance stops writing records. An operator must investigate: docs/ops/ledger-watch.md."
  namespace           = local.api_metrics
  metric_name         = "LedgerCompromised"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.api_ledger_compromised]
}

resource "aws_cloudwatch_metric_alarm" "api_unhealthy_targets" {
  count               = local.api_service_count
  alarm_name          = "${local.name}-api-unhealthy-targets"
  alarm_description   = "A task failed its readiness check for three minutes (database down, migrations pending, or the record log failed a check)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    TargetGroup  = aws_lb_target_group.api[0].arn_suffix
    LoadBalancer = aws_lb.api[0].arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "api_target_5xx" {
  count               = local.api_service_count
  alarm_name          = "${local.name}-api-target-5xx"
  alarm_description   = "The API answered ten or more server errors in five minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    TargetGroup  = aws_lb_target_group.api[0].arn_suffix
    LoadBalancer = aws_lb.api[0].arn_suffix
  }
}

# Missing data counts as a breach here: no report from Container Insights means no running task is reporting.
resource "aws_cloudwatch_metric_alarm" "api_running_tasks" {
  count               = local.api_service_count
  alarm_name          = "${local.name}-api-running-tasks"
  alarm_description   = "Fewer API tasks are running than api_desired_count."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = var.api_desired_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    ClusterName = aws_ecs_cluster.api[0].name
    ServiceName = aws_ecs_service.api[0].name
  }
}

output "api_log_group" {
  description = "Where the API's logs go."
  value       = var.enable_api_hosting ? aws_cloudwatch_log_group.api[0].name : null
}

output "api_secret_arns" {
  description = "The secret containers to fill by hand (values are never in Terraform)."
  value = var.enable_api_hosting ? {
    database_url                 = aws_secretsmanager_secret.api_database_url[0].arn
    ledger_verifier_database_url = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn
    migrator_database_url        = aws_secretsmanager_secret.api_migrator_url[0].arn
    invitation_digest_key        = aws_secretsmanager_secret.api_invitation_digest_key[0].arn
  } : null
}

output "api_cluster_name" {
  value = var.enable_api_hosting ? aws_ecs_cluster.api[0].name : null
}

output "api_migrate_task_family" {
  description = "Run this task definition once before a release (docs/ops/api-hosting.md)."
  value       = local.api_service_count == 1 ? aws_ecs_task_definition.api_migrate[0].family : null
}

output "api_provision_task_family" {
  description = "Run this task definition once before the first migration, and again after it (docs/ops/api-hosting.md, \"The database logins\")."
  value       = local.api_service_count == 1 ? aws_ecs_task_definition.api_provision[0].family : null
}
