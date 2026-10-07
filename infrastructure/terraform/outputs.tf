output "reports_bucket" {
  description = "REPORTS_BUCKET for the API."
  value       = aws_s3_bucket.reports.bucket
}

output "backups_bucket" {
  description = "Destination for `db:backup --upload s3://<this>/<prefix>` (in the backup region)."
  value       = aws_s3_bucket.backups.bucket
}

output "backup_kms_key_arn" {
  description = "Pass as --kms-key-id to `db:backup`."
  value       = aws_kms_key.backup.arn
}

output "db_endpoint" {
  description = "Host and port of the database (not publicly reachable)."
  value       = aws_db_instance.main.endpoint
}

output "db_master_secret_arn" {
  description = "Secrets Manager secret holding the admin credentials (used only by migrations and backups)."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "app_runtime_policy_arn" {
  value = aws_iam_policy.app_runtime.arn
}

output "backup_job_policy_arn" {
  value = aws_iam_policy.backup_job.arn
}
