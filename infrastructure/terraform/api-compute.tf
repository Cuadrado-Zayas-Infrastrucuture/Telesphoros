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

variable "api_migrate_image" {
  description = "Optional: the image the one-off migration task runs, pinned by digest like api_image. Empty (the default) runs it with api_image. To migrate before a release, set this to the NEW digest and apply: only the migration task definition changes, and the API service and worker keep running api_image until it is set to match."
  type        = string
  default     = ""
  validation {
    condition     = var.api_migrate_image == "" || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.api_migrate_image))
    error_message = "api_migrate_image must be empty or an ECR image pinned by digest: <account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<64 hex>."
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
  api_environment = merge({
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
    DATABASE_POOL_MAX                 = tostring(var.api_db_pool_max)
    CORS_ALLOWED_ORIGINS              = join(",", var.api_cors_origins)
    RATE_LIMIT_ENABLED                = "true"
    TRUST_PROXY_HOPS                  = "1"
    BUILD_VERSION                     = local.api_build
    LEDGER_FULL_VERIFY_INTERVAL_HOURS = "24"
    # ISSUER_URL (DATA-01) is not typed here: it is built from the issuer's own names in issuer.tf and exists only while the issuer service does.
  }, local.issuer_client_environment)
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

resource "aws_secretsmanager_secret" "api_identifier_digest_key" {
  count       = local.api_count
  name        = "${local.name}/api/identifier-digest-key"
  description = "IDENTIFIER_DIGEST_KEY: 64 hex characters (openssl rand -hex 32), the master for the digests of patient identifiers. Value set by hand and NEVER rotated casually: raw identifiers are not kept, so replacing it orphans every stored identifier (docs/ops/patient-identifiers.md)."
  kms_key_id  = aws_kms_key.data.arn

  recovery_window_in_days = local.secret_recovery_days
}

# The API's own certificate and key (PEM) for the load balancer hop (audit FE-02). Containers only, as above: the values are set by hand.
resource "aws_secretsmanager_secret" "api_tls_cert" {
  count       = local.api_count
  name        = "${local.name}/api/tls-certificate"
  description = "TLS_CERT_PEM: the API certificate (PEM) the load balancer reaches the task with. Value set by hand."
  kms_key_id  = aws_kms_key.data.arn

  recovery_window_in_days = local.secret_recovery_days
}

resource "aws_secretsmanager_secret" "api_tls_key" {
  count       = local.api_count
  name        = "${local.name}/api/tls-private-key"
  description = "TLS_KEY_PEM: the private key for the API certificate. Value set by hand and NEVER in Terraform or state."
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
# task: the service's can read the runtime secrets, the migration task's can read only the migrator secret. Neither is the application's identity.
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
    resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_invitation_digest_key[0].arn, aws_secretsmanager_secret.api_identifier_digest_key[0].arn, aws_secretsmanager_secret.api_tls_cert[0].arn, aws_secretsmanager_secret.api_tls_key[0].arn]
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
#  - the TASK role is what the command runs as: it can read and write exactly the five connection-string secrets (the session issuer's is the fifth), and it can NOT read the administrator secret.
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
    sid       = "ReadAndWriteTheFiveConnectionStrings"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
    resources = [aws_secretsmanager_secret.api_database_url[0].arn, aws_secretsmanager_secret.api_ledger_verifier_url[0].arn, aws_secretsmanager_secret.api_migrator_url[0].arn, aws_secretsmanager_secret.worker_database_url[0].arn, aws_secretsmanager_secret.issuer_database_url[0].arn]
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

  # Fargate has no tmpfs, and the root filesystem stays read-only. Report intake stages uploads in os.tmpdir() (/tmp), so that one
  # path is an ephemeral volume: it lives and dies with the task, holds no database or report state, and no host path is bound.
  volume {
    name = "scratch"
  }

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
      mountPoints            = [{ sourceVolume = "scratch", containerPath = "/tmp", readOnly = false }]
      environment            = [for name, value in local.api_environment : { name = name, value = value }]
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_database_url[0].arn },
        { name = "LEDGER_VERIFIER_DATABASE_URL", valueFrom = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },
        { name = "INVITATION_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_invitation_digest_key[0].arn },
        { name = "IDENTIFIER_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.api_identifier_digest_key[0].arn },
        { name = "TLS_CERT_PEM", valueFrom = aws_secretsmanager_secret.api_tls_cert[0].arn },
        { name = "TLS_KEY_PEM", valueFrom = aws_secretsmanager_secret.api_tls_key[0].arn },
      ]
      # Liveness: a wedged process (an event loop that no longer answers) is replaced by ECS. It asks /api/v1/health, which touches no dependency, so a database slowdown
      # cannot restart healthy tasks; the load balancer keeps asking /api/v1/ready. The listener is TLS with a certificate the load balancer does not verify, and nor does this
      # loopback request. Not counted during the first 60 seconds.
      healthCheck = {
        command     = ["CMD", "node", "-e", "process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';fetch('https://127.0.0.1:${local.api_port}/api/v1/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
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
      image                  = var.api_migrate_image != "" ? var.api_migrate_image : var.api_image
      essential              = true
      user                   = local.api_user
      readonlyRootFilesystem = true
      command                = ["dist/db/cli.js", "migrate", "up"]
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

# One-off, run by a person before the first migration and again after it (docs/ops/api-hosting.md): creates the five database logins with generated passwords and
# writes their connection strings into the five secrets (the session issuer's, PROVISION_SECRET_ISSUER, is the fifth: the command creates that login only when this names its secret). The administrator's credentials come from the RDS-managed secret through the execution role; no password
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
      command                = ["dist/db/cli.js", "provision-logins"]
      environment = [
        { name = "DATABASE_SSL", value = "require" },
        { name = "DATABASE_HOST", value = aws_db_instance.main.address },
        { name = "DATABASE_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DATABASE_NAME", value = aws_db_instance.main.db_name },
        { name = "AWS_REGION", value = var.region },
        { name = "PROVISION_SECRET_APP", value = aws_secretsmanager_secret.api_database_url[0].arn },
        { name = "PROVISION_SECRET_VERIFIER", value = aws_secretsmanager_secret.api_ledger_verifier_url[0].arn },
        { name = "PROVISION_SECRET_MIGRATOR", value = aws_secretsmanager_secret.api_migrator_url[0].arn },
        { name = "PROVISION_SECRET_WORKER", value = aws_secretsmanager_secret.worker_database_url[0].arn },
        { name = "PROVISION_SECRET_ISSUER", value = aws_secretsmanager_secret.issuer_database_url[0].arn },
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

  # Without this, `terraform apply` returns as soon as the service is updated: a deployment the circuit breaker then rolls back would still read as a success.
  # With it, apply waits for the new tasks to become steady and fails if the deployment fails.
  wait_for_steady_state = true

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

  # The API is a Service Connect CLIENT of the session issuer (DATA-01): it joins the namespace so `session-issuer` resolves, and publishes nothing. Only while the
  # issuer service exists, so with enable_issuer off the plan for this service does not change.
  dynamic "service_connect_configuration" {
    for_each = local.issuer_service_count == 1 ? [1] : []
    content {
      enabled   = true
      namespace = aws_service_discovery_http_namespace.internal[0].arn
    }
  }

  lifecycle {
    # The scalable target (api-autoscaling.tf) owns the running count once the service exists; without this an apply would set it back to
    # api_desired_count in the middle of a scale-out.
    ignore_changes = [desired_count]

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

# The API process hit an uncaught exception or an unhandled rejection and ended (apps/backend/src/common/process-faults.ts writes one line with a top-level `event`).
# ECS replaces the task, so without this the only trace would be a restart. One occurrence is worth a person looking: it is a bug, not a blip.
resource "aws_cloudwatch_log_metric_filter" "api_process_fault" {
  count          = local.api_count
  name           = "${local.name}-api-process-fault"
  log_group_name = aws_cloudwatch_log_group.api[0].name
  pattern        = "{ $.event = \"process-fault\" }"
  metric_transformation {
    name      = "ProcessFaults"
    namespace = local.api_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_process_fault" {
  count               = local.api_count
  alarm_name          = "${local.name}-api-process-fault"
  alarm_description   = "An API task ended on an uncaught exception or an unhandled rejection and was replaced. Read the `process-fault` line (the error class and code, never the message) in the API log group."
  namespace           = local.api_metrics
  metric_name         = "ProcessFaults"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.api_process_fault]
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

# Errors the load balancer itself answers are not in HTTPCode_Target_5XX_Count, so the alarm above cannot see them. A 502 is what a caller gets when the
# balancer reuses a connection the API has already closed (the API's keepAliveTimeout must stay above the balancer's idle timeout; see app.factory.ts), or
# when a task drops a request; a 504 is a task that did not answer within the balancer's idle timeout. Five in five minutes is a judgement, not a measurement.
resource "aws_cloudwatch_metric_alarm" "api_elb_502" {
  count               = local.api_service_count
  alarm_name          = "${local.name}-api-elb-502"
  alarm_description   = "The load balancer answered five or more 502s in five minutes (a connection the API closed, or a task that dropped a request)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_502_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    LoadBalancer = aws_lb.api[0].arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "api_elb_504" {
  count               = local.api_service_count
  alarm_name          = "${local.name}-api-elb-504"
  alarm_description   = "The load balancer answered five or more 504s in five minutes (a task did not answer within the idle timeout)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_504_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    LoadBalancer = aws_lb.api[0].arn_suffix
  }
}

# Two more lines from the record-log watch (ledger-monitor.ts; each has a top-level `event`, pinned like the compromise line above). Neither is damage; both mean the
# record log is not being fully checked. One alarm notification per state change, not per pass: while the line keeps coming, the alarm stays in ALARM and says nothing more.
# A failed verification (the check could not run: login, network, missing tables), written at start and by each background pass.
resource "aws_cloudwatch_log_metric_filter" "api_ledger_verification_error" {
  count          = local.api_count
  name           = "${local.name}-api-ledger-verification-error"
  log_group_name = aws_cloudwatch_log_group.api[0].name
  pattern        = "{ $.event = \"ledger-verification-error\" }"
  metric_transformation {
    name      = "LedgerVerificationErrors"
    namespace = local.api_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_ledger_verification_error" {
  count               = local.api_count
  alarm_name          = "${local.name}-api-ledger-verification-error"
  alarm_description   = "The record log could not be checked (the verifier login, the network or the tables). Nothing is known about it until a check succeeds: docs/ops/ledger-watch.md."
  namespace           = local.api_metrics
  metric_name         = "LedgerVerificationErrors"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.api_ledger_verification_error]
}

# A tenant's record log is longer than one verification walks (1 000 000 events), so it can never be fully verified; nothing is contained and nothing is recorded as verified.
resource "aws_cloudwatch_log_metric_filter" "api_ledger_chain_over_size" {
  count          = local.api_count
  name           = "${local.name}-api-ledger-chain-over-size"
  log_group_name = aws_cloudwatch_log_group.api[0].name
  pattern        = "{ $.event = \"ledger-chain-over-size\" }"
  metric_transformation {
    name      = "LedgerChainOverSize"
    namespace = local.api_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_ledger_chain_over_size" {
  count               = local.api_count
  alarm_name          = "${local.name}-api-ledger-chain-over-size"
  alarm_description   = "A tenant's record log is longer than one verification walks, so it cannot be fully verified. Not damage: see docs/ops/ledger-watch.md (a checkpoint does not help; the walk limit must be dealt with)."
  namespace           = local.api_metrics
  metric_name         = "LedgerChainOverSize"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.api_ledger_chain_over_size]
}

# The record-log watch is silent when all is well, so the alarms above cannot tell a healthy watch from a stopped one. Every full walk that reaches every
# tenant writes one heartbeat line (ledger-monitor.ts); walks run at each API start and then every LEDGER_FULL_VERIFY_INTERVAL_HOURS (24) with ±10% jitter,
# so 30 hours without one means the walks stopped or keep falling short. Missing data is the signal here, so it breaches. Counted by the running service,
# like api_running_tasks: before an image runs there is no watch to hear from. Apply it with an image built from the commit that writes the line, or it
# fires 30 hours later.
resource "aws_cloudwatch_log_metric_filter" "api_ledger_full_check" {
  count          = local.api_service_count
  name           = "${local.name}-api-ledger-full-check"
  log_group_name = aws_cloudwatch_log_group.api[0].name
  pattern        = "{ $.event = \"ledger-full-check-completed\" }"
  metric_transformation {
    name      = "LedgerFullChecks"
    namespace = local.api_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_ledger_check_stale" {
  count               = local.api_service_count
  alarm_name          = "${local.name}-api-ledger-check-stale"
  alarm_description   = "No full check of the record log has reached every tenant for 30 hours: the watch stopped, or every walk falls short. Damage would go unseen: docs/ops/ledger-watch.md."
  namespace           = local.api_metrics
  metric_name         = "LedgerFullChecks"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 30
  datapoints_to_alarm = 30
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.api_ledger_full_check]
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
    identifier_digest_key        = aws_secretsmanager_secret.api_identifier_digest_key[0].arn
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

output "api_service_name" {
  description = "The API service, for `aws ecs update-service --force-new-deployment` once the database logins and migrations are done (docs/ops/staging-rehearsal.md). Null until api_image is set."
  value       = local.api_service_count == 1 ? aws_ecs_service.api[0].name : null
}

output "api_task_subnet_ids" {
  description = "The subnets the one-off tasks run in (scripts/staging/run-task.sh, TASK_SUBNETS): the service's own subnets."
  value       = var.enable_api_hosting ? local.data_subnet_ids : null
}

output "api_task_assign_public_ip" {
  description = "Whether the one-off tasks need a public address to reach the registry and AWS services (true only in the synthetic profile with its own network, which has no NAT). scripts/staging/run-task.sh, TASK_ASSIGN_PUBLIC_IP."
  value       = var.enable_api_hosting ? local.tasks_public_ip : null
}
