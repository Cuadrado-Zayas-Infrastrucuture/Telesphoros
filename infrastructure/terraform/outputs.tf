output "reports_bucket" {
  description = "REPORTS_BUCKET for the API."
  value       = aws_s3_bucket.reports.bucket
}

output "deployment_profile" {
  description = "production or synthetic (profile.tf)."
  value       = var.deployment_profile
}

output "backups_bucket" {
  description = "Destination for `db:backup --upload s3://<this>/<prefix>` (in the backup region). Null under the synthetic profile: there is no second Region."
  value       = local.synthetic ? null : aws_s3_bucket.backups[0].bucket
}

output "backup_kms_key_arn" {
  description = "Pass as --kms-key-id to `db:backup`. Null under the synthetic profile."
  value       = local.synthetic ? null : aws_kms_key.backup[0].arn
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
  description = "Null under the synthetic profile."
  value       = local.synthetic ? null : aws_iam_policy.backup_job[0].arn
}

# ---- Authentication: settings for the API and the frontend ----
output "cognito_user_pool_id" {
  description = "COGNITO_USER_POOL_ID for the API."
  value       = aws_cognito_user_pool.main.id
}

output "cognito_app_client_id" {
  description = "COGNITO_APP_CLIENT_ID for the API and VITE_OIDC_CLIENT_ID for the frontend."
  value       = aws_cognito_user_pool_client.spa.id
}

output "cognito_issuer" {
  description = "VITE_OIDC_AUTHORITY for the frontend (the API derives the same value from region + pool id)."
  value       = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
}

output "cognito_sign_in_domain" {
  description = "VITE_COGNITO_DOMAIN for the frontend (used for sign-out)."
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
}

# ---- Audit trail (F1) ----
output "audit_bucket" {
  description = "Where the CloudTrail logs and their signed digest files are kept (Object Lock)."
  value       = aws_s3_bucket.audit.bucket
}

output "audit_trail_name" {
  description = "The audit trail (multi-Region in the production profile). Check it with `aws cloudtrail get-trail-status --name <this>`."
  value       = aws_cloudtrail.audit.name
}

output "audit_alarm_topic_arn" {
  description = "The SNS topic audit alarms publish to. Later alarms (for example ledger-compromised) should publish here too."
  value       = aws_sns_topic.audit_alarms.arn
}
