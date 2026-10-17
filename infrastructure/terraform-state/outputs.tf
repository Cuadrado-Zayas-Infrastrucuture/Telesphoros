output "bucket_name" {
  value = aws_s3_bucket.state.bucket
}

output "kms_key_arn" {
  value = aws_kms_key.state.arn
}

# A descriptor only: no backend block, main wiring, credentials or live initialization.
# https://developer.hashicorp.com/terraform/language/backend/s3
output "backend_config" {
  value = {
    bucket       = aws_s3_bucket.state.bucket
    key          = var.state_key
    region       = var.region
    encrypt      = true
    kms_key_id   = aws_kms_key.state.arn
    use_lockfile = true
  }
}
