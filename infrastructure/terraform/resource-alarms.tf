# Alarms on resources nothing watched yet (observability plan A3, approved 2026-11-11): the burstable database's CPU credits, free memory and read
# latency, API and worker CPU and memory, and the password notifier's own failures. Into the audit topic like every other alarm, with recovery
# notices. resource-alarms.guard.test.mjs keeps these rules. The thresholds are judgements, not measurements: each is a number a person can change.
# CloudFront 5xx is NOT here on purpose: CloudFront's metrics exist only in us-east-1, and the project stays in one Region.

# CPU credits. A burstable class (db.t*) spends credits above its baseline; at zero it is held to the baseline (or charged for surplus credits
# in unlimited mode), and queries slow while CPU % can still look moderate. Created only for a burstable class.
resource "aws_cloudwatch_metric_alarm" "database_cpu_credits_low" {
  count               = startswith(local.db_instance_class, "db.t") ? 1 : 0
  alarm_name          = "${local.name}-database-cpu-credits-low"
  alarm_description   = "The database's CPU credit balance has been under 20 for 15 minutes. A burstable instance at zero is held to its baseline CPU (or charged for surplus credits): look for a runaway query before resizing."
  namespace           = "AWS/RDS"
  metric_name         = "CPUCreditBalance"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 20
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  ok_actions          = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

# Free memory. 128 MiB is an eighth of a db.t4g.micro's 1 GiB: below it PostgreSQL's caches are being squeezed and the instance swaps.
resource "aws_cloudwatch_metric_alarm" "database_memory_low" {
  alarm_name          = "${local.name}-database-memory-low"
  alarm_description   = "The database has had under 128 MiB of freeable memory for 15 minutes. Caches are being squeezed: look at connections and large queries before resizing."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 134217728
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  ok_actions          = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

# Read latency. An average over 100 ms per read for 15 minutes means the disk, not the query plan, is the bottleneck (gp3 reads are usually ~1 ms).
resource "aws_cloudwatch_metric_alarm" "database_read_latency_high" {
  alarm_name          = "${local.name}-database-read-latency-high"
  alarm_description   = "Database reads have averaged over 100 ms for 15 minutes. Check storage throughput and the credit balance before changing queries."
  namespace           = "AWS/RDS"
  metric_name         = "ReadLatency"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 0.1
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  ok_actions          = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

# API and worker CPU and memory, as a share of what each task reserves. Over 90% for 15 minutes: the task is close to being throttled (CPU) or
# killed for running out of memory, which the running-task and heartbeat alarms would only report afterwards.
locals {
  service_resource_alarms = local.api_service_count == 0 ? {} : {
    api-cpu-high       = { service = aws_ecs_service.api[0].name, metric = "CPUUtilization", what = "CPU" }
    api-memory-high    = { service = aws_ecs_service.api[0].name, metric = "MemoryUtilization", what = "memory" }
    worker-cpu-high    = { service = aws_ecs_service.worker[0].name, metric = "CPUUtilization", what = "CPU" }
    worker-memory-high = { service = aws_ecs_service.worker[0].name, metric = "MemoryUtilization", what = "memory" }
  }
}

resource "aws_cloudwatch_metric_alarm" "service_resources" {
  for_each            = local.service_resource_alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = "${each.value.service} has averaged over 90% of its reserved ${each.value.what} for 15 minutes. Look for a runaway request or job before raising the task size."
  namespace           = "AWS/ECS"
  metric_name         = each.value.metric
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  ok_actions          = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    ClusterName = aws_ecs_cluster.api[0].name
    ServiceName = each.value.service
  }
}

# The password notifier failing outright (a crash, a timeout, a permission error), not only the notices it logs as lost.
resource "aws_cloudwatch_metric_alarm" "password_notifier_errors" {
  alarm_name          = "${local.name}-password-notifier-errors"
  alarm_description   = "The password-change notifier Lambda failed. A password may have changed without its notice: read the function's log for the error class."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  ok_actions          = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    FunctionName = aws_lambda_function.password_notifier.function_name
  }
}
