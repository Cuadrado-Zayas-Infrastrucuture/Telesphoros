resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = var.private_subnet_ids
}

# Only the named application security groups can reach the database. No other ingress, no public address.
resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL for ${local.name}: reachable only from the application"
  vpc_id      = var.vpc_id
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

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

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

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false

  backup_retention_period   = var.db_backup_retention_days
  backup_window             = "07:00-08:00" # UTC, early morning in Puerto Rico
  maintenance_window        = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  auto_minor_version_upgrade            = true
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  performance_insights_retention_period = 7

  lifecycle {
    precondition {
      condition     = var.environment != "production" || var.db_multi_az
      error_message = "Production requires db_multi_az = true."
    }
    precondition {
      condition     = var.environment != "production" || var.db_deletion_protection
      error_message = "Production requires db_deletion_protection = true."
    }
  }
}

# Automated backups (point-in-time recovery) are copied to the separate region as well, so losing
# the primary region does not lose the recovery points.
resource "aws_db_instance_automated_backups_replication" "offsite" {
  provider               = aws.backup
  source_db_instance_arn = aws_db_instance.main.arn
  kms_key_id             = aws_kms_key.backup.arn
  retention_period       = var.db_backup_retention_days
}
