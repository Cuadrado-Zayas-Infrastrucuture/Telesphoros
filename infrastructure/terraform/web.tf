# H1: static frontend only. NOT APPLIED. Off by default; no deployment workflow or DNS writes.
variable "enable_web_hosting" {
  description = "Opt in only after the hosting plan, costs and first-apply gates have been approved."
  type        = bool
  default     = false
}

variable "web_domain" {
  description = "Product domain administered in Cloudflare. Company DNS is outside this module."
  type        = string
  default     = "telesphoros.app"
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.web_domain))
    error_message = "web_domain must be a lowercase DNS name without a scheme, path or wildcard."
  }
}

provider "aws" {
  alias  = "web_certificate"
  region = "us-east-1"
  default_tags {
    tags = merge(local.tags, { Component = "web", DataClassification = "public-code" })
  }
}

locals {
  web_count   = var.enable_web_hosting ? 1 : 0
  web_app     = "app.${var.web_domain}"
  web_api     = "https://api.${var.web_domain}"
  web_aliases = [local.web_app, var.web_domain, "www.${var.web_domain}"]
  web_tags    = merge(local.tags, { Component = "web", DataClassification = "public-code" })
  # Presigned uploads go directly to the existing regional reports endpoint. No wildcard origins.
  web_connect = join(" ", [
    "'self'", local.web_api,
    "https://cognito-idp.${var.region}.amazonaws.com",
    "https://${var.cognito_domain_prefix}.auth.${var.region}.amazoncognito.com",
    "https://${aws_s3_bucket.reports.bucket_regional_domain_name}"
  ])
}

resource "aws_s3_bucket" "web" {
  count         = local.web_count
  bucket_prefix = "${local.name}-web-"
  force_destroy = false
  tags          = local.web_tags
}

resource "aws_s3_bucket_public_access_block" "web" {
  count                   = local.web_count
  bucket                  = aws_s3_bucket.web[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  count  = local.web_count
  bucket = aws_s3_bucket.web[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "web" {
  count  = local.web_count
  bucket = aws_s3_bucket.web[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  count  = local.web_count
  bucket = aws_s3_bucket.web[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  count                             = local.web_count
  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_acm_certificate" "web" {
  count                     = local.web_count
  provider                  = aws.web_certificate
  domain_name               = local.web_app
  subject_alternative_names = [var.web_domain, "www.${var.web_domain}"]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# Outputs expose validation CNAMEs; Jan adds them in Cloudflare. Terraform never manages the zone.
resource "aws_acm_certificate_validation" "web" {
  count           = local.web_count
  provider        = aws.web_certificate
  certificate_arn = aws_acm_certificate.web[0].arn
}

resource "aws_cloudfront_function" "web" {
  count   = local.web_count
  name    = "${local.name}-web-routing"
  runtime = "cloudfront-js-2.0"
  publish = true
  code = templatefile("${path.module}/web-routing.js.tftpl", {
    app_host_json       = jsonencode(local.web_app)
    redirect_hosts_json = jsonencode([var.web_domain, "www.${var.web_domain}"])
  })
}

resource "aws_cloudfront_response_headers_policy" "web" {
  count = local.web_count
  name  = "${local.name}-web"
  security_headers_config {
    content_security_policy {
      # Existing React components use inline styles. Inline scripts and eval remain forbidden.
      content_security_policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${local.web_connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
      override                = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 86400
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
  }
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=()"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "web" {
  count               = local.web_count
  enabled             = true
  aliases             = local.web_aliases
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  tags                = local.web_tags
  origin {
    domain_name              = aws_s3_bucket.web[0].bucket_regional_domain_name
    origin_id                = "web-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.web[0].id
  }
  default_cache_behavior {
    target_origin_id       = "web-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # AWS managed CachingDisabled: shell/auth responses are never cached.
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web[0].id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.web[0].arn
    }
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.web[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
  # No 403/404-to-200 mapping: missing assets and origin failures must remain visible.
  lifecycle {
    precondition {
      condition     = contains(var.app_callback_urls, "https://${local.web_app}/auth/callback") && contains(var.app_logout_urls, "https://${local.web_app}/signed-out") && contains(var.reports_cors_origins, "https://${local.web_app}")
      error_message = "Enable hosting only with the exact app callback, logout and report-upload origins configured."
    }
  }
}

data "aws_iam_policy_document" "web" {
  count = local.web_count
  statement {
    sid       = "CloudFrontReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web[0].arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web[0].arn]
    }
  }
  statement {
    sid       = "DenyPlainHttp"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.web[0].arn, "${aws_s3_bucket.web[0].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  count  = local.web_count
  bucket = aws_s3_bucket.web[0].id
  policy = data.aws_iam_policy_document.web[0].json
}

output "web_validation_cnames" {
  description = "Add these certificate validation records in Cloudflare, DNS-only; do not remove after validation."
  value       = var.enable_web_hosting ? aws_acm_certificate.web[0].domain_validation_options : []
}

output "web_bucket" {
  value = var.enable_web_hosting ? aws_s3_bucket.web[0].id : null
}

output "web_cloudfront_domain" {
  description = "DNS target for app, apex (flattened CNAME), and www; not an API target."
  value       = var.enable_web_hosting ? aws_cloudfront_distribution.web[0].domain_name : null
}
