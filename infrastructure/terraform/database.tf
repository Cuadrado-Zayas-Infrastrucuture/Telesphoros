resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = local.data_subnet_ids
}

# Only the named application security groups can reach the database. No other ingress, no public address.
resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL for ${local.name}: reachable only from the application"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  for_each                     = toset(var.app_security_group_ids)
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the application"
}

resource "aws_db_parameter_group" "main" {
  name   = local.name
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  # DDL only. Never log_statement=all: statements can contain clinical data.
  parameter {
    name  = "log_statement"
    value = "ddl"
  }
}

# The exported logs land in groups RDS would otherwise create itself on first write: no expiry, no customer key, and invisible to Terraform. So each
# one is declared here, from the same list the instance exports, and the instance waits for them (audit finding INF-12).
locals {
  rds_log_exports = ["postgresql", "upgrade"]
}

resource "aws_cloudwatch_log_group" "rds" {
  for_each          = toset(local.rds_log_exports)
  name              = "/aws/rds/instance/${local.name}/${each.value}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.service_logs.arn
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = local.db_instance_class

  db_name  = "telesphoros"
  username = "telesphoros_admin"
  # RDS creates and rotates the admin password in Secrets Manager. It never appears in code or in state.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.data.arn

  storage_type          = "gp3"
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn

  multi_az               = local.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false

  backup_retention_period   = local.db_backup_retention
  backup_window             = "07:00-08:00" # UTC, early morning in Puerto Rico
  maintenance_window        = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = local.db_deletion_protection
  skip_final_snapshot       = local.synthetic
  final_snapshot_identifier = local.synthetic ? null : "${local.name}-final"

  auto_minor_version_upgrade            = true
  enabled_cloudwatch_logs_exports       = local.rds_log_exports
  performance_insights_enabled          = local.db_performance_insights
  performance_insights_kms_key_id       = local.db_performance_insights ? aws_kms_key.data.arn : null
  performance_insights_retention_period = local.db_performance_insights ? 7 : null

  lifecycle {
    # database-connections.tf: every hosted service at its largest count must fit what the instance accepts.
    precondition {
      condition     = var.environment != "production" || var.db_connection_budget != null
      error_message = "Production requires db_connection_budget from a live SHOW max_connections reading, not the class estimate."
    }
    precondition {
      condition     = local.connection_budget != null
      error_message = "There is no connection estimate for this db_instance_class: set db_connection_budget from SHOW max_connections."
    }
    precondition {
      condition     = local.connection_budget == null || local.connection_demand <= coalesce(local.connection_budget, 0)
      error_message = "The hosted services could open more database connections than db_connection_budget allows (see the db_connection_demand output): lower a desired count or api_db_pool_max, or raise the budget from a live reading."
    }
    precondition {
      condition     = length(var.app_security_group_ids) >= 1 || var.enable_api_hosting
      error_message = "Name at least one application security group (app_security_group_ids), or enable_api_hosting so the API tasks' group is the one allowed."
    }
    precondition {
      condition     = var.environment != "production" || var.db_multi_az
      error_message = "Production requires db_multi_az = true."
    }
    precondition {
      condition     = var.environment != "production" || var.db_deletion_protection
      error_message = "Production requires db_deletion_protection = true."
    }
    precondition {
      condition     = var.environment != "production" || var.db_backup_retention_days >= 7
      error_message = "Production requires db_backup_retention_days >= 7: a shorter point-in-time window can be outlived by a problem nobody has noticed yet."
    }
  }

  depends_on = [aws_cloudwatch_log_group.rds]
}

# Automated backups (point-in-time recovery) are copied to the separate region as well, so losing
# the primary region does not lose the recovery points. (Absent under the synthetic profile: single-Region.)
resource "aws_db_instance_automated_backups_replication" "offsite" {
  count                  = local.offsite_count
  provider               = aws.backup
  source_db_instance_arn = aws_db_instance.main.arn
  kms_key_id             = aws_kms_key.backup[0].arn
  retention_period       = var.db_backup_retention_days
}
