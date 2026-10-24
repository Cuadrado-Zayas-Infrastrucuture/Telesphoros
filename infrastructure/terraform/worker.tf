# M2.3c: the background worker's compute (service, roles, secret container, log group, alarms). NOT APPLIED. Off by default: it follows the API's switch
# (enable_api_hosting) and, like the API's service, also needs `api_image` (the worker is the SAME image; its `command` is `worker/main.js` because the image ENTRYPOINT is `node`).
# Plan: docs/design/plans/m2-3-jobs-outbox-worker.md. Design and runbook: docs/ops/jobs.md. It uses the API's cluster, subnets and execution-role pattern (api-compute.tf).

variable "worker_desired_count" {
  description = "How many worker tasks run. One is enough (jobs wait in the database; two workers never run the same job at once)."
  type        = number
  default     = 1
  validation {
    condition     = var.worker_desired_count >= 1 && var.worker_desired_count <= 5
    error_message = "worker_desired_count must be between 1 and 5."
  }
}

variable "worker_cpu" {
  description = "Fargate CPU units for the worker."
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Fargate memory (MiB) for the worker."
  type        = number
  default     = 512
}

locals {
  worker_container = "worker"
  worker_log_group = "/ecs/${local.name}-worker"
  worker_metrics   = "${local.name}/Worker"
  worker_health    = 8081

  # Everything the worker's production start-up demands (apps/worker/src/config.ts), and nothing it refuses (no test jobs). The login arrives as DATABASE_URL from the
  # worker's own secret. A test in the worker package hands this block to the worker's own loader.
  worker_environment = {
    NODE_ENV             = "production"
    DATABASE_SSL         = "require"
    REPORTS_BUCKET       = aws_s3_bucket.reports.bucket
    AWS_REGION           = var.region
    WORKER_CONCURRENCY   = "4"
    WORKER_TENANT_CAP    = "2"
    WORKER_DRAIN_SECONDS = "30"
    WORKER_HEALTH_HOST   = "127.0.0.1"
    WORKER_HEALTH_PORT   = tostring(local.worker_health)
  }
}

# ------------------------------------------------------------------------------------------------
# The worker's own logs: a log group with its own key (not the API's, the data key or the audit key).
# ------------------------------------------------------------------------------------------------
data "aws_iam_policy_document" "worker_logs_key" {
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
    sid       = "CloudWatchLogsEncryptTheWorkerLogGroup"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.worker_log_group}"]
    }
  }
}

resource "aws_kms_key" "worker_logs" {
  count                   = local.api_count
  description             = "${local.name} worker logs"
  enable_key_rotation     = true
  deletion_window_in_days = local.kms_deletion_days
  policy                  = data.aws_iam_policy_document.worker_logs_key.json
}

resource "aws_kms_alias" "worker_logs" {
  count         = local.api_count
  name          = "alias/${local.name}-worker-logs"
  target_key_id = aws_kms_key.worker_logs[0].key_id
}

resource "aws_cloudwatch_log_group" "worker" {
  count             = local.api_count
  name              = local.worker_log_group
  retention_in_days = var.api_log_retention_days
  kms_key_id        = aws_kms_key.worker_logs[0].arn
}

# ------------------------------------------------------------------------------------------------
# The secret CONTAINER for the worker's database login. Terraform never sees a value: `provision-logins` writes it (docs/ops/api-hosting.md).
# ------------------------------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "worker_database_url" {
  count       = local.api_count
  name        = "${local.name}/worker/database-url"
  description = "DATABASE_URL for the worker: the job-worker login (member of telesphoros_worker only). Written by provision-logins."
  kms_key_id  = aws_kms_key.data.arn

  recovery_window_in_days = local.secret_recovery_days
}

# ------------------------------------------------------------------------------------------------
# Network: the worker accepts no connection at all (its health probe is loopback, checked by the container itself). Out only to the database and to AWS over HTTPS.
# ------------------------------------------------------------------------------------------------
resource "aws_security_group" "worker_tasks" {
  count       = local.api_count
  name        = "${local.name}-worker-tasks"
  description = "Worker tasks for ${local.name}: no inbound traffic, out only to the database and to AWS over HTTPS"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "worker_tasks_to_database" {
  count                        = local.api_count
  security_group_id            = aws_security_group.worker_tasks[0].id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

resource "aws_vpc_security_group_egress_rule" "worker_tasks_https_out" {
  count             = local.api_count
  security_group_id = aws_security_group.worker_tasks[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to AWS services (the reports bucket, Secrets Manager, CloudWatch Logs)"
}

resource "aws_vpc_security_group_ingress_rule" "worker_db_from_tasks" {
  count                        = local.api_count
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.worker_tasks[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the worker tasks"
}

# ------------------------------------------------------------------------------------------------
# Roles. The TASK role is the worker's own identity: READ-ONLY on the report files (the stored-file re-check). The EXECUTION role starts the task: it pulls this image,
# writes the worker's log group and reads ONLY the worker's secret.
# ------------------------------------------------------------------------------------------------
resource "aws_iam_role" "worker_task" {
  count              = local.api_count
  name               = "${local.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "worker_task_runtime" {
  count      = local.api_count
  role       = aws_iam_role.worker_task[0].name
  policy_arn = aws_iam_policy.worker_runtime.arn
}

data "aws_iam_policy_document" "worker_execution" {
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
    resources = ["arn:aws:logs:${var.region}:${local.audit_account_id}:log-group:${local.worker_log_group}:*"]
  }
  statement {
    sid       = "ReadTheWorkerSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.worker_database_url[0].arn]
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

resource "aws_iam_role" "worker_execution" {
  count              = local.api_count
  name               = "${local.name}-worker-exec"
  assume_role_policy = data.aws_iam_policy_document.api_ecs_assume.json
}

resource "aws_iam_role_policy" "worker_execution" {
  count  = local.api_count
  name   = "start-the-worker"
  role   = aws_iam_role.worker_execution[0].id
  policy = data.aws_iam_policy_document.worker_execution[0].json
}

# ------------------------------------------------------------------------------------------------
# Task definition and service (the API's cluster). No load balancer: nothing calls the worker.
# ------------------------------------------------------------------------------------------------
resource "aws_ecs_task_definition" "worker" {
  count                    = local.api_service_count
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.worker_execution[0].arn
  task_role_arn            = aws_iam_role.worker_task[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                   = local.worker_container
      image                  = var.api_image
      essential              = true
      user                   = local.api_user
      readonlyRootFilesystem = true
      command                = ["worker/main.js"]
      stopTimeout            = 60
      environment            = [for name, value in local.worker_environment : { name = name, value = value }]
      secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.worker_database_url[0].arn }]
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:${local.worker_health}/livez').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker[0].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  count                              = local.api_service_count
  name                               = "${local.name}-worker"
  cluster                            = aws_ecs_cluster.api[0].id
  task_definition                    = aws_ecs_task_definition.worker[0].arn
  desired_count                      = var.worker_desired_count
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
    security_groups  = [aws_security_group.worker_tasks[0].id]
    assign_public_ip = local.tasks_public_ip
  }
}

# ------------------------------------------------------------------------------------------------
# Alarms, into the audit topic so one confirmed email address hears everything. The worker writes these lines as JSON with a top-level `event` field
# (apps/worker/src/log.ts); a test keeps the patterns and the worker's literals in agreement.
# ------------------------------------------------------------------------------------------------
# A job ended dead: it failed for good and waits for a person (`jobs dead`, docs/ops/jobs.md).
resource "aws_cloudwatch_log_metric_filter" "worker_job_dead" {
  count          = local.api_count
  name           = "${local.name}-worker-job-dead"
  log_group_name = aws_cloudwatch_log_group.worker[0].name
  pattern        = "{ $.event = \"job-finished\" && $.outcome = \"dead\" }"
  metric_transformation {
    name      = "JobsDead"
    namespace = local.worker_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_job_dead" {
  count               = local.api_count
  alarm_name          = "${local.name}-worker-job-dead"
  alarm_description   = "A background job ended dead and waits for a person: run `jobs dead` (docs/ops/jobs.md)."
  namespace           = local.worker_metrics
  metric_name         = "JobsDead"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker_job_dead]
}

# A stored report file no longer matches what its report is pinned to (a missing version, different bytes, size or type). This is a finding, not an outage: nothing was repaired.
resource "aws_cloudwatch_log_metric_filter" "worker_file_check_failed" {
  count          = local.api_count
  name           = "${local.name}-worker-file-check-failed"
  log_group_name = aws_cloudwatch_log_group.worker[0].name
  pattern        = "{ ($.event = \"file-verified\" && $.outcome != \"ok\") || ($.event = \"files-reverified\" && $.running > 0) }"
  metric_transformation {
    name      = "FileChecksFailed"
    namespace = local.worker_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_file_check_failed" {
  count               = local.api_count
  alarm_name          = "${local.name}-worker-file-check-failed"
  alarm_description   = "A stored report file failed its integrity re-check. Nothing was changed. Read the finding: docs/ops/jobs.md, 'A failed re-check'."
  namespace           = local.worker_metrics
  metric_name         = "FileChecksFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker_file_check_failed]
}

# The worker logs the queue's depth and the age of its oldest ready job once a minute (`queue-stats`). Held jobs of a suspended organization are not counted.
resource "aws_cloudwatch_log_metric_filter" "worker_queue_age" {
  count          = local.api_count
  name           = "${local.name}-worker-queue-age"
  log_group_name = aws_cloudwatch_log_group.worker[0].name
  pattern        = "{ $.event = \"queue-stats\" }"
  metric_transformation {
    name      = "QueueAgeSeconds"
    namespace = local.worker_metrics
    value     = "$.ageSeconds"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_queue_not_draining" {
  count               = local.api_count
  alarm_name          = "${local.name}-worker-queue-not-draining"
  alarm_description   = "The oldest ready background job has waited more than 15 minutes for two checks running. Workers are down, stuck or too slow: `jobs status`."
  namespace           = local.worker_metrics
  metric_name         = "QueueAgeSeconds"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker_queue_age]
}

# No `queue-stats` line for five minutes: no worker is alive and reporting (stopped, crashed in a loop, or cut off from the database).
resource "aws_cloudwatch_log_metric_filter" "worker_heartbeat" {
  count          = local.api_count
  name           = "${local.name}-worker-heartbeat"
  log_group_name = aws_cloudwatch_log_group.worker[0].name
  pattern        = "{ $.event = \"queue-stats\" }"
  metric_transformation {
    name      = "WorkerHeartbeats"
    namespace = local.worker_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_heartbeat_stale" {
  count               = local.api_count
  alarm_name          = "${local.name}-worker-heartbeat-stale"
  alarm_description   = "No worker has reported for five minutes. Background jobs are not running (nothing is lost: they wait in the database)."
  namespace           = local.worker_metrics
  metric_name         = "WorkerHeartbeats"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker_heartbeat]
}

# Silent failures. None of these has an exception to raise: the lease-expiry dead letter is decided inside the database (job_claim), and the relay and the scheduler
# log a failure and try again on their next tick. Each alarm below reads a line the worker already writes (a test runs the worker's own Ticker to produce them).
#
# A job is dead and waits for a person, however it got there. `worker_job_dead` above fires once when a handler's failure ends a job; it never sees a job whose lease
# expired on its last attempt, because that is decided in SQL and no worker logs it. The `queue-stats` line carries the number of dead jobs, so this alarm stays in alarm
# until the dead jobs are retried or cancelled (`jobs dead`, `jobs retry`, `jobs cancel`). It cannot say why a job died: `jobs show` can. A job whose lease expired but
# which still has attempts left is not dead yet, and is not seen here.
resource "aws_cloudwatch_log_metric_filter" "worker_dead_waiting" {
  count          = local.api_count
  name           = "${local.name}-worker-dead-waiting"
  log_group_name = aws_cloudwatch_log_group.worker[0].name
  pattern        = "{ $.event = \"queue-stats\" }"
  metric_transformation {
    name      = "JobsDeadWaiting"
    namespace = local.worker_metrics
    value     = "$.dead"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_dead_waiting" {
  count               = local.api_count
  alarm_name          = "${local.name}-worker-dead-waiting"
  alarm_description   = "One or more background jobs are dead and wait for a person, whatever killed them (including a lease that expired on the last attempt, which no log line reports). Run `jobs dead`, then `jobs show` (docs/ops/jobs.md)."
  namespace           = local.worker_metrics
  metric_name         = "JobsDeadWaiting"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker_dead_waiting]
}

# The outbox relay (turns pending outbox events into jobs) and the scheduler (creates the recurring jobs) each log `<name>-failed` and retry. One failure is a blip.
# A failure in each of three consecutive one-minute periods is a database that has been unreachable or failing for between one and three minutes, about two minutes
# typically, whatever each tick's cadence: while it lasts, events are not becoming jobs, or the hourly sweep and the daily re-check are not being created.
# Minutes with no failure publish no data point, which counts as healthy; a worker that is down entirely is the heartbeat alarm's.
resource "aws_cloudwatch_log_metric_filter" "worker_relay_failed" {
  count          = local.api_count
  name           = "${local.name}-worker-relay-failed"
  log_group_name = aws_cloudwatch_log_group.worker[0].name
  pattern        = "{ $.event = \"outbox-relay-failed\" }"
  metric_transformation {
    name      = "OutboxRelayFailures"
    namespace = local.worker_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_relay_failing" {
  count               = local.api_count
  alarm_name          = "${local.name}-worker-relay-failing"
  alarm_description   = "The outbox relay has failed in each of the last three minutes: events are not becoming jobs. Check the database and the worker log (docs/ops/jobs.md); nothing is lost, events wait in the outbox."
  namespace           = local.worker_metrics
  metric_name         = "OutboxRelayFailures"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker_relay_failed]
}

resource "aws_cloudwatch_log_metric_filter" "worker_schedule_failed" {
  count          = local.api_count
  name           = "${local.name}-worker-schedule-failed"
  log_group_name = aws_cloudwatch_log_group.worker[0].name
  pattern        = "{ $.event = \"schedule-failed\" }"
  metric_transformation {
    name      = "ScheduleFailures"
    namespace = local.worker_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_schedule_failing" {
  count               = local.api_count
  alarm_name          = "${local.name}-worker-schedule-failing"
  alarm_description   = "The scheduler has failed in each of the last three minutes: recurring jobs (the upload sweep, the stored-file re-check) are not being created. Check the database and the worker log (docs/ops/jobs.md)."
  namespace           = local.worker_metrics
  metric_name         = "ScheduleFailures"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker_schedule_failed]
}

# The worker process hit an uncaught exception or an unhandled rejection and ended (apps/worker/src/process-faults.ts writes one `process-fault` line).
# ECS replaces the task and its jobs wait for the lease to expire; one occurrence is worth a person looking.
resource "aws_cloudwatch_log_metric_filter" "worker_process_fault" {
  count          = local.api_count
  name           = "${local.name}-worker-process-fault"
  log_group_name = aws_cloudwatch_log_group.worker[0].name
  pattern        = "{ $.event = \"process-fault\" }"
  metric_transformation {
    name      = "ProcessFaults"
    namespace = local.worker_metrics
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_process_fault" {
  count               = local.api_count
  alarm_name          = "${local.name}-worker-process-fault"
  alarm_description   = "A worker task ended on an uncaught exception or an unhandled rejection and was replaced. Read the `process-fault` line (the error class, never the message) in the worker log group (docs/ops/jobs.md)."
  namespace           = local.worker_metrics
  metric_name         = "ProcessFaults"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker_process_fault]
}

# An outbox event that has waited a long time has not become a job. The relay isolates a failing event (migration 0036), so it returns normally and logs no failure:
# the age of the oldest pending event, which the worker puts on its `queue-stats` line, is how it shows. Normal lag is seconds (the relay runs every few seconds); ten
# minutes means a stuck event or a relay that is not running. Query it as the owner (docs/ops/jobs.md); the PostgreSQL log has a WARNING with the event id.
resource "aws_cloudwatch_log_metric_filter" "worker_outbox_age" {
  count          = local.api_count
  name           = "${local.name}-worker-outbox-age"
  log_group_name = aws_cloudwatch_log_group.worker[0].name
  pattern        = "{ $.event = \"queue-stats\" }"
  metric_transformation {
    name      = "OutboxAgeSeconds"
    namespace = local.worker_metrics
    value     = "$.outboxAgeSeconds"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_outbox_stuck" {
  count               = local.api_count
  alarm_name          = "${local.name}-worker-outbox-stuck"
  alarm_description   = "An outbox event has waited more than ten minutes without becoming a job: one event is failing (the relay skips it and goes on) or the relay is not running. Nothing is lost; read docs/ops/jobs.md, 'The outbox'."
  namespace           = local.worker_metrics
  metric_name         = "OutboxAgeSeconds"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker_outbox_age]
}

output "worker_secret_arn" {
  description = "The worker's database-login secret container (written by provision-logins; the value is never in Terraform)."
  value       = var.enable_api_hosting ? aws_secretsmanager_secret.worker_database_url[0].arn : null
}

output "worker_service_name" {
  value = local.api_service_count == 1 ? aws_ecs_service.worker[0].name : null
}
