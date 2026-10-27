# Alarms on the database instance itself (database.tf), into the audit topic so one confirmed email address hears everything. The application and worker alarms watch
# what they log; nothing watched the instance, so a full disk, a pinned CPU or a connection limit reached would show only as errors elsewhere.
# The thresholds are judgements, not measurements: nothing has run against this instance. Each is a number a person can change here.

# Free space. Storage autoscaling (db_max_allocated_storage) grows the disk when free space falls under about 10% (and under 10 GiB on small disks); this alarm means free space is
# low anyway: the disk is at its ceiling, or growing as fast as it fills. 4 GiB is a fifth of the default 20 GiB. Three five-minute periods so a vacuum or a restore does not page.
resource "aws_cloudwatch_metric_alarm" "database_low_storage" {
  alarm_name          = "${local.name}-database-low-storage"
  alarm_description   = "The database has had under 4 GiB of free storage for 15 minutes. Autoscaling may be at its ceiling (db_max_allocated_storage) or the data is growing faster than the disk."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 4294967296
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

# CPU. Sustained, not a spike: an average over 80% for three five-minute periods. On a burstable class (db.t4g.*) this is also the sign that the credit balance is being spent.
resource "aws_cloudwatch_metric_alarm" "database_cpu_high" {
  alarm_name          = "${local.name}-database-cpu-high"
  alarm_description   = "Database CPU has averaged over 80% for 15 minutes. Look for a runaway query or a deploy surge before resizing the instance."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}

# Connections. The threshold is 80% of the connection budget (database-connections.tf): the live SHOW max_connections reading once
# db_connection_budget is set, the class estimate until then (54 on db.t4g.micro). The plan already refuses task counts whose deploy peak exceeds the
# budget, so this fires on connections the sum does not explain (a leak, a stuck deploy, a manual session) or a peak close to the limit.
# If it fires, compare db_connection_demand with the metric before raising anything. One five-minute period is enough: a deploy lasts a few minutes.
resource "aws_cloudwatch_metric_alarm" "database_connections_high" {
  alarm_name          = "${local.name}-database-connections-high"
  alarm_description   = "The database has had more than ${floor(coalesce(local.connection_budget, 0) * 0.8)} connections open, 80% of the connection budget of ${coalesce(local.connection_budget, 0)}. Compare with the db_connection_demand output: a leak, a stuck deploy or a manual session may be holding connections."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = floor(coalesce(local.connection_budget, 0) * 0.8)
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}
