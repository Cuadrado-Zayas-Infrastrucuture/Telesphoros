# DATA-01 slice 2b: the session issuer's compute (service, roles, secret container, network, log group, alarms). WRITTEN, NEVER APPLIED. Off by default.
# The issuer verifies a person's Cognito access token and mints a 60-second tenant capability through ONE database function (migration 0028). It is the
# only principal that can. So it must not share anything the API can reach: it has its own execution role, its own task role, its own secret, its own security group and its own log group.
# Spec: specs/001-tenant-capability/. Task T019. Transport and its prices: docs/design/plans/tenant-capability-issuer-transport.md (and its addendum).
# The pattern is the worker's (worker.tf): same image, same cluster, same subnets, an execution role that reads only its own secret.
#
# TWO THINGS THE REPOSITORY DOES NOT HAVE YET, so the service is behind its own switch (enable_issuer, default false):
#  - the entry point. The issuer core (apps/backend/src/issuer/issuer-core.ts) opens no port and listens for nothing, and the image builds no `issuer/main.js`.
#    The task below is written for the entry it will need (`node issuer/main.js`, reading PORT and DATABASE_URL); an application PR provides it.
#  - the client. The API still runs with NullCapabilityIssuer. Joining the Service Connect namespace below and calling the issuer is the client PR's job.

variable "enable_issuer" {
  description = "Run the session issuer service. Leave false until the image contains the issuer entry point (issuer/main.js) and the API has a client for it: with neither, the service could not start."
  type        = bool
  default     = false
}

variable "issuer_desired_count" {
  description = "How many issuer tasks run. The issuer is on every request's path and fails closed (a 503 for everyone) once enforcement is on, so production needs at least two."
  type        = number
  default     = 1
  validation {
    condition     = var.issuer_desired_count >= 1 && var.issuer_desired_count <= 10
    error_message = "issuer_desired_count must be between 1 and 10."
  }
}

variable "issuer_cpu" {
  description = "Fargate CPU units per issuer task. A first guess: it verifies a token and makes one database call. Measure in staging."
  type        = number
  default     = 256
  validation {
    condition     = contains([256, 512, 1024], var.issuer_cpu)
    error_message = "issuer_cpu must be 256, 512 or 1024."
  }
}

variable "issuer_memory" {
  description = "Fargate memory (MiB) per issuer task. It must be a size Fargate allows for issuer_cpu. A first guess: measure in staging."
  type        = number
  default     = 512
  validation {
    condition     = var.issuer_memory >= 512 && var.issuer_memory <= 4096
    error_message = "issuer_memory must be between 512 and 4096."
  }
}

variable "issuer_tls_ca_arn" {
  description = "ARN of an existing AWS Private CA (short-lived certificate mode, tagged AmazonECSManaged=true) that issues the issuer's Service Connect certificate, so the access token the API sends is encrypted in the VPC. This file does not create the CA: it is a monthly cost the founder decides (see the transport addendum). Production refuses to run the service without it."
  type        = string
  default     = ""
  validation {
    condition     = var.issuer_tls_ca_arn == "" || can(regex("^arn:aws:acm-pca:[a-z0-9-]+:[0-9]{12}:certificate-authority/[0-9a-f-]{36}$", var.issuer_tls_ca_arn))
    error_message = "issuer_tls_ca_arn must be empty or an AWS Private CA ARN (arn:aws:acm-pca:<region>:<account>:certificate-authority/<uuid>)."
  }
}

locals {
  issuer_service_count = local.api_service_count == 1 && var.enable_issuer ? 1 : 0
  # The Service Connect certificate role exists only when hosting is on AND a Private CA is named.
  issuer_tls_count = local.api_count == 1 && var.issuer_tls_ca_arn != "" ? 1 : 0
  issuer_container = "issuer"
  issuer_log_group = "/ecs/${local.name}-issuer"
  issuer_metrics   = "${local.name}/Issuer"
  # The listener the issuer entry must open. Not the API's port and not the worker's health port.
  issuer_port = 8082
  # The name the API will use inside the namespace: http://session-issuer:8082.
  issuer_dns_name = "session-issuer"

  # What the issuer core needs to verify a token and nothing else: the same three Cognito values the API sets, the port, TLS to the database and production mode.
  # The login arrives as DATABASE_URL from the issuer's own secret. COGNITO_ISSUER and COGNITO_JWKS_URI are development overrides that production refuses (config/env.ts).
  issuer_environment = {
    NODE_ENV              = "production"
    PORT                  = tostring(local.issuer_port)
    DATABASE_SSL          = "require"
    COGNITO_REGION        = var.region
    COGNITO_USER_POOL_ID  = aws_cognito_user_pool.main.id
    COGNITO_APP_CLIENT_ID = aws_cognito_user_pool_client.spa.id
  }
}

# ------------------------------------------------------------------------------------------------
# The issuer's own logs: a log group with its own key (not the API's, the worker's, the data key or the audit key). The issuer logs reason codes and request ids, never a token.
# ------------------------------------------------------------------------------------------------
data "aws_iam_policy_document" "issuer_logs_key" {
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
    sid       = "CloudWatchLogsEncryptTheIssuerLogGroup"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.issuer_log_group}"]
    }
  }
}

resource "aws_kms_key" "issuer_logs" {
  count                   = local.api_count
  description             = "${local.name} issuer logs"
  enable_key_rotation     = true
  deletion_window_in_days = local.kms_deletion_days
  policy                  = data.aws_iam_policy_document.issuer_logs_key.json
}

resource "aws_kms_alias" "issuer_logs" {
  count         = local.api_count
  name          = "alias/${local.name}-issuer-logs"
  target_key_id = aws_kms_key.issuer_logs[0].key_id
}

resource "aws_cloudwatch_log_group" "issuer" {
  count             = local.api_count
  name              = local.issuer_log_group
  retention_in_days = var.api_log_retention_days
  kms_key_id        = aws_kms_key.issuer_logs[0].arn
}

# ------------------------------------------------------------------------------------------------
# The secret CONTAINER for the issuer's database login (telesphoros_session_issuer). Terraform never sees a value: `provision-logins` writes it when PROVISION_SECRET_ISSUER names this
# secret. No role of the API can read it: only the issuer's execution role below.
# ------------------------------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "issuer_database_url" {
  count       = local.api_count
  name        = "${local.name}/issuer/database-url"
  description = "DATABASE_URL for the session issuer: the telesphoros_session_issuer login (member of telesphoros_issuer only). Written by provision-logins. No API role may read it."
  kms_key_id  = aws_kms_key.data.arn

  recovery_window_in_days = local.secret_recovery_days
}

# ------------------------------------------------------------------------------------------------
# Network: ONE way in (the API tasks, on the issuer port). Out only to the database and to HTTPS (Cognito's key endpoint, the registry, Secrets Manager, CloudWatch Logs).
# The caller check is this rule plus Service Connect TLS in transit; there is no application-level shared secret (transport addendum, "The caller check").
# ------------------------------------------------------------------------------------------------
resource "aws_security_group" "issuer_tasks" {
  count       = local.api_count
  name        = "${local.name}-issuer-tasks"
  description = "Session issuer tasks for ${local.name}: traffic only from the API tasks, out only to the database and to HTTPS"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "issuer_tasks_from_api" {
  count                        = local.api_count
  security_group_id            = aws_security_group.issuer_tasks[0].id
  referenced_security_group_id = aws_security_group.api_tasks[0].id
  ip_protocol                  = "tcp"
  from_port                    = local.issuer_port
  to_port                      = local.issuer_port
  description                  = "From the API tasks only"
}

# The other half of the same connection: the API's group may send to the issuer's group on the issuer port. A separate rule resource, so api-edge.tf is untouched.
resource "aws_vpc_security_group_egress_rule" "api_tasks_to_issuer" {
  count                        = local.api_count
  security_group_id            = aws_security_group.api_tasks[0].id
  referenced_security_group_id = aws_security_group.issuer_tasks[0].id
  ip_protocol                  = "tcp"
  from_port                    = local.issuer_port
  to_port                      = local.issuer_port
  description                  = "To the session issuer tasks only"
}

resource "aws_vpc_security_group_egress_rule" "issuer_tasks_to_database" {
  count                        = local.api_count
  security_group_id            = aws_security_group.issuer_tasks[0].id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

resource "aws_vpc_security_group_egress_rule" "issuer_tasks_https_out" {
  count             = local.api_count
  security_group_id = aws_security_group.issuer_tasks[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to the Cognito key endpoint and to AWS services"
}

resource "aws_vpc_security_group_ingress_rule" "issuer_db_from_tasks" {
  count                        = local.api_count
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.issuer_tasks[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the session issuer tasks"
}

# ------------------------------------------------------------------------------------------------
# Entry point: Service Connect. A private (HTTP) namespace groups the API and the issuer; the issuer is the one server in it. The API joins as a client in the client PR.
# Service Connect itself has no charge; the Private CA that encrypts the traffic does (transport addendum). No load balancer, no public name, no certificate to validate by hand.
# ------------------------------------------------------------------------------------------------
resource "aws_service_discovery_http_namespace" "internal" {
  count       = local.api_count
  name        = "${local.name}-internal"
  description = "Private service-to-service names for ${local.name} (Service Connect). The session issuer is the only server in it."
}

# ------------------------------------------------------------------------------------------------
# Roles. The TASK role is the issuer's own identity and holds NO permission: it makes no AWS API call (it reaches the database and Cognito's public keys only). The EXECUTION role starts the
# task: it pulls this image, writes the issuer's log group and reads ONLY the issuer's secret. The infrastructure role lets ECS issue the Service Connect certificate from the one named CA.
# ------------------------------------------------------------------------------------------------
resource "aws_iam_role" "issuer_task" {
  count              = local.api_count
  name               = "${local.name}-issuer-task"
  assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json
}

data "aws_iam_policy_document" "issuer_execution" {
  count = local.api_count
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
    resources = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.issuer_log_group}:*"]
  }
  statement {
    sid       = "ReadTheIssuerSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.issuer_database_url[0].arn]
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

resource "aws_iam_role" "issuer_execution" {
  count              = local.api_count
  name               = "${local.name}-issuer-exec"
  assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json
}

resource "aws_iam_role_policy" "issuer_execution" {
  count  = local.api_count
  name   = "start-the-issuer"
  role   = aws_iam_role.issuer_execution[0].id
  policy = data.aws_iam_policy_document.issuer_execution[0].json
}

# The role ECS itself uses to issue and rotate the Service Connect certificate (not the task's identity). The AWS-managed policy for it grants these actions on "*"; this copy names the one CA and the
# ecs-sc! secrets ECS creates, and keeps every condition the managed policy has (AmazonECSInfrastructureRolePolicyForServiceConnectTransportLayerSecurity, version 4, read 2026-10-20).
data "aws_iam_policy_document" "issuer_service_connect_tls_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.audit_account_id]
    }
  }
}

data "aws_iam_policy_document" "issuer_service_connect_tls" {
  count = local.issuer_tls_count
  statement {
    sid       = "CreateAndTagTheCertificateSecret"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:TagResource"]
    resources = ["arn:aws:secretsmanager:${var.region}:${local.audit_account_id}:secret:ecs-sc!*"]
    condition {
      test     = "ArnLike"
      variable = "aws:RequestTag/AmazonECSCreated"
      values   = ["arn:aws:ecs:${var.region}:${local.audit_account_id}:service/*/*", "arn:aws:ecs:${var.region}:${local.audit_account_id}:task-set/*/*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/AmazonECSManaged"
      values   = ["true"]
    }
  }
  statement {
    sid       = "RotateTheCertificateSecret"
    actions   = ["secretsmanager:UpdateSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret", "secretsmanager:RotateSecret", "secretsmanager:UpdateSecretVersionStage", "secretsmanager:DescribeSecret"]
    resources = ["arn:aws:secretsmanager:${var.region}:${local.audit_account_id}:secret:ecs-sc!*"]
    condition {
      test     = "StringEquals"
      variable = "secretsmanager:ResourceTag/aws:secretsmanager:owningService"
      values   = ["ecs-sc"]
    }
  }
  statement {
    sid       = "ReadTheNamedCertificateAuthority"
    actions   = ["acm-pca:GetCertificate", "acm-pca:GetCertificateAuthorityCertificate", "acm-pca:DescribeCertificateAuthority"]
    resources = [var.issuer_tls_ca_arn]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/AmazonECSManaged"
      values   = ["true"]
    }
  }
  statement {
    sid       = "IssueEndEntityCertificatesFromTheNamedCertificateAuthority"
    actions   = ["acm-pca:IssueCertificate"]
    resources = [var.issuer_tls_ca_arn]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/AmazonECSManaged"
      values   = ["true"]
    }
    condition {
      test     = "StringEquals"
      variable = "acm-pca:TemplateArn"
      values   = ["arn:aws:acm-pca:::template/EndEntityCertificate/V1"]
    }
  }
}

resource "aws_iam_role" "issuer_service_connect_tls" {
  count              = local.issuer_tls_count
  name               = "${local.name}-issuer-sc-tls"
  assume_role_policy = data.aws_iam_policy_document.issuer_service_connect_tls_assume.json
}

resource "aws_iam_role_policy" "issuer_service_connect_tls" {
  count  = local.issuer_tls_count
  name   = "issue-the-service-certificate"
  role   = aws_iam_role.issuer_service_connect_tls[0].id
  policy = data.aws_iam_policy_document.issuer_service_connect_tls[0].json
}

# ------------------------------------------------------------------------------------------------
# Task definition and service (the API's cluster). Nothing but the API tasks can reach the port (the security group); no load balancer.
# ------------------------------------------------------------------------------------------------
resource "aws_ecs_task_definition" "issuer" {
  count                    = local.issuer_service_count
  family                   = "${local.name}-issuer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.issuer_cpu
  memory                   = var.issuer_memory
  execution_role_arn       = aws_iam_role.issuer_execution[0].arn
  task_role_arn            = aws_iam_role.issuer_task[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                   = local.issuer_container
      image                  = var.api_image
      essential              = true
      user                   = local.api_user
      readonlyRootFilesystem = true
      command                = ["node", "issuer/main.js"]
      stopTimeout            = 30
      portMappings           = [{ name = "issuer", containerPort = local.issuer_port, protocol = "tcp", appProtocol = "http" }]
      environment            = [for name, value in local.issuer_environment : { name = name, value = value }]
      secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.issuer_database_url[0].arn }]
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:${local.issuer_port}/livez').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.issuer[0].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "issuer"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "issuer" {
  count                              = local.issuer_service_count
  name                               = "${local.name}-issuer"
  cluster                            = aws_ecs_cluster.api[0].id
  task_definition                    = aws_ecs_task_definition.issuer[0].arn
  desired_count                      = var.issuer_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  enable_execute_command             = false
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.data_subnet_ids
    security_groups  = [aws_security_group.issuer_tasks[0].id]
    assign_public_ip = local.tasks_public_ip
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.internal[0].arn

    service {
      port_name      = "issuer"
      discovery_name = local.issuer_dns_name
      client_alias {
        port     = local.issuer_port
        dns_name = local.issuer_dns_name
      }
      dynamic "tls" {
        for_each = var.issuer_tls_ca_arn == "" ? [] : [1]
        content {
          role_arn = aws_iam_role.issuer_service_connect_tls[0].arn
          issuer_cert_authority {
            aws_pca_authority_arn = var.issuer_tls_ca_arn
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.environment != "production" || var.issuer_desired_count >= 2
      error_message = "Production runs at least two issuer tasks (issuer_desired_count >= 2): an outage of the issuer is a 503 for every request."
    }
    precondition {
      condition     = var.environment != "production" || var.issuer_tls_ca_arn != ""
      error_message = "Production encrypts the issuer connection: set issuer_tls_ca_arn (the access token crosses it)."
    }
  }
}

# ------------------------------------------------------------------------------------------------
# Alarms, into the audit topic so one confirmed email address hears everything. The issuer core writes reason codes through Nest's Logger (issuer-core.ts); a test keeps the two phrases below
# and the core's literals in agreement. Thresholds are provisional: set them from the staging measurement (decision D4).
# ------------------------------------------------------------------------------------------------
# The issuer could not reach the database or got no answer: every request fails closed while this lasts.
resource "aws_cloudwatch_log_metric_filter" "issuer_unavailable" {
  count          = local.api_count
  name           = "${local.name}-issuer-unavailable"
  log_group_name = aws_cloudwatch_log_group.issuer[0].name
  pattern        = "\"Capability not issued: unavailable\""
  metric_transformation {
    name      = "IssuerUnavailable"
    namespace = local.issuer_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "issuer_unavailable" {
  count               = local.api_count
  alarm_name          = "${local.name}-issuer-unavailable"
  alarm_description   = "The session issuer failed five or more issuances in five minutes because the database did not answer. Once enforcement is on, requests fail with 503 (DATA-01 decision D4)."
  namespace           = local.issuer_metrics
  metric_name         = "IssuerUnavailable"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.issuer_unavailable]
}

# The database refused issuance because a person asked too often. The limit is the database's (migration 0028); a burst is either a bug in a client or a relayed token being used.
resource "aws_cloudwatch_log_metric_filter" "issuer_rate_limited" {
  count          = local.api_count
  name           = "${local.name}-issuer-rate-limited"
  log_group_name = aws_cloudwatch_log_group.issuer[0].name
  pattern        = "\"Capability not issued: refused (rate-limited)\""
  metric_transformation {
    name      = "IssuerRateLimited"
    namespace = local.issuer_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "issuer_rate_limited" {
  count               = local.api_count
  alarm_name          = "${local.name}-issuer-rate-limited"
  alarm_description   = "Ten or more issuances were refused as rate-limited in five minutes. Look for a client retry loop or a relayed access token: docs/design/plans/tenant-capability-issuer-transport.md."
  namespace           = local.issuer_metrics
  metric_name         = "IssuerRateLimited"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.issuer_rate_limited]
}

# Missing data counts as a breach: no report from Container Insights means no running issuer task is reporting.
resource "aws_cloudwatch_metric_alarm" "issuer_running_tasks" {
  count               = local.issuer_service_count
  alarm_name          = "${local.name}-issuer-running-tasks"
  alarm_description   = "Fewer session issuer tasks are running than issuer_desired_count. With enforcement on, every request needs the issuer."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = var.issuer_desired_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    ClusterName = aws_ecs_cluster.api[0].name
    ServiceName = aws_ecs_service.issuer[0].name
  }
}

# The issuer sits on every request's path, so a saturated task is a latency problem for the whole API before it is an outage.
resource "aws_cloudwatch_metric_alarm" "issuer_cpu_high" {
  count               = local.issuer_service_count
  alarm_name          = "${local.name}-issuer-cpu-high"
  alarm_description   = "Session issuer CPU stayed above 80 percent for three minutes. Add tasks or CPU (issuer_desired_count, issuer_cpu) before requests slow down."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    ClusterName = aws_ecs_cluster.api[0].name
    ServiceName = aws_ecs_service.issuer[0].name
  }
}

output "issuer_secret_arn" {
  description = "The session issuer's database-login secret container (written by provision-logins via PROVISION_SECRET_ISSUER; the value is never in Terraform)."
  value       = var.enable_api_hosting ? aws_secretsmanager_secret.issuer_database_url[0].arn : null
}

output "issuer_service_name" {
  value = local.issuer_service_count == 1 ? aws_ecs_service.issuer[0].name : null
}

output "issuer_namespace_arn" {
  description = "The Service Connect namespace the API joins as a client (the client PR)."
  value       = var.enable_api_hosting ? aws_service_discovery_http_namespace.internal[0].arn : null
}
