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

# Connections. PostgreSQL's default limit is a function of the instance's memory (the formula AWS documents for Aurora PostgreSQL is DBInstanceClassMemory / 9531392; RDS PostgreSQL's
# row was not read), roughly 100 on db.t4g.micro and 200 on db.t4g.small. 80 is under the smaller of those and above what the pilot's task counts open: each API task holds a pool, and so does
# each worker. If it fires, count the tasks times their pool sizes before raising it. One five-minute period is enough: a deploy surge doubles the tasks for a few minutes.
resource "aws_cloudwatch_metric_alarm" "database_connections_high" {
  alarm_name          = "${local.name}-database-connections-high"
  alarm_description   = "The database has had more than 80 connections open. The limit depends on the instance class; tasks times pool sizes, doubled in a deploy surge, may be reaching it."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
}
