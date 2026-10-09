# F3a: the API's edge (certificate, load balancer, firewall, security groups). NOT APPLIED. Off by default.
# The compute that sits behind it (cluster, service, task, roles, secrets, alarms) is F3b. Plan: docs/design/plans/f3-api-hosting.md.
# Design: docs/ops/api-hosting.md. Enabling this switch is NOT approval to apply the rest of the root (see README.md).

variable "enable_api_hosting" {
  description = "Opt in only after the hosting plan, costs and first-apply gates have been approved."
  type        = bool
  default     = false
}

variable "api_domain" {
  description = "Public name of the API, administered in Cloudflare (DNS only). Terraform never writes the zone."
  type        = string
  default     = "api.telesphoros.app"
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.api_domain))
    error_message = "api_domain must be a lowercase DNS name without a scheme, path or wildcard."
  }
}

variable "public_subnet_ids" {
  description = "Public subnets (at least two, different availability zones) for the load balancer only. The application and the database stay in private_subnet_ids."
  type        = list(string)
  default     = []
}

variable "api_rate_limit_per_5min" {
  description = "Firewall ceiling per client address over five minutes. A shared backstop above the in-process limits (rate-limiting.md). The firewall's minimum is 10."
  type        = number
  default     = 2000
  validation {
    condition     = var.api_rate_limit_per_5min >= 10 && var.api_rate_limit_per_5min <= 20000000
    error_message = "api_rate_limit_per_5min must be between 10 and 20000000."
  }
}

locals {
  api_count = var.enable_api_hosting ? 1 : 0
  # Must agree with the application: PORT's default in config/env.ts and the readiness route (guard test api.guard.test.mjs).
  api_port       = 3000
  api_ready_path = "/api/v1/ready"
}

# ------------------------------------------------------------------------------------------------
# Certificate. DNS-validated; Terraform waits for the validation CNAME that is added by hand in Cloudflare.
# ------------------------------------------------------------------------------------------------
resource "aws_acm_certificate" "api" {
  count             = local.api_count
  domain_name       = var.api_domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# Read the requested record from the ACM console while the apply waits; the output below repeats it afterwards.
resource "aws_acm_certificate_validation" "api" {
  count           = local.api_count
  certificate_arn = aws_acm_certificate.api[0].arn
}

# ------------------------------------------------------------------------------------------------
# Security groups. Rules only (no inline blocks). Nothing here allows all traffic.
# ------------------------------------------------------------------------------------------------
resource "aws_security_group" "api_alb" {
  count       = local.api_count
  name        = "${local.name}-api-alb"
  description = "Load balancer for ${local.name}: HTTPS from the internet, traffic only to the application"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "api_tasks" {
  count       = local.api_count
  name        = "${local.name}-api-tasks"
  description = "API tasks for ${local.name}: traffic only from the load balancer, out only to the database and to AWS over HTTPS"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "api_alb_https" {
  count             = local.api_count
  security_group_id = aws_security_group.api_alb[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from the internet (the firewall filters it)"
}

resource "aws_vpc_security_group_egress_rule" "api_alb_to_tasks" {
  count                        = local.api_count
  security_group_id            = aws_security_group.api_alb[0].id
  referenced_security_group_id = aws_security_group.api_tasks[0].id
  ip_protocol                  = "tcp"
  from_port                    = local.api_port
  to_port                      = local.api_port
  description                  = "To the API tasks only"
}

resource "aws_vpc_security_group_ingress_rule" "api_tasks_from_alb" {
  count                        = local.api_count
  security_group_id            = aws_security_group.api_tasks[0].id
  referenced_security_group_id = aws_security_group.api_alb[0].id
  ip_protocol                  = "tcp"
  from_port                    = local.api_port
  to_port                      = local.api_port
  description                  = "From the load balancer only"
}

resource "aws_vpc_security_group_egress_rule" "api_tasks_to_database" {
  count                        = local.api_count
  security_group_id            = aws_security_group.api_tasks[0].id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

# AWS service endpoints and Cognito's public key endpoint are reached over HTTPS through the VPC's outbound path (NAT, decided in the plan).
resource "aws_vpc_security_group_egress_rule" "api_tasks_https_out" {
  count             = local.api_count
  security_group_id = aws_security_group.api_tasks[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to AWS services and the Cognito key endpoint"
}

# The database accepts the API tasks, in addition to whatever app_security_group_ids names.
resource "aws_vpc_security_group_ingress_rule" "api_db_from_tasks" {
  count                        = local.api_count
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.api_tasks[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the API tasks"
}

# ------------------------------------------------------------------------------------------------
# Load balancer: HTTPS only. No port-80 listener exists, so there is no plain-text path to redirect.
# Access logging is deliberately NOT configured: request lines carry record identifiers (see docs/ops/api-hosting.md).
# ------------------------------------------------------------------------------------------------
resource "aws_lb" "api" {
  count                      = local.api_count
  name                       = "${local.name}-api"
  load_balancer_type         = "application"
  internal                   = false
  ip_address_type            = "ipv4"
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.api_alb[0].id]
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_deletion_protection = var.environment == "production"
  idle_timeout               = 60

  lifecycle {
    precondition {
      condition     = length(var.public_subnet_ids) >= 2
      error_message = "The load balancer needs at least two public subnets in different availability zones (public_subnet_ids)."
    }
  }
}

resource "aws_lb_target_group" "api" {
  count                = local.api_count
  name                 = "${local.name}-api"
  vpc_id               = var.vpc_id
  protocol             = "HTTP"
  port                 = local.api_port
  target_type          = "ip"
  deregistration_delay = 30

  # Readiness, not liveness: a task whose database is down, whose migrations are pending or whose record log failed a check leaves rotation.
  health_check {
    protocol            = "HTTP"
    path                = local.api_ready_path
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "api_https" {
  count             = local.api_count
  load_balancer_arn = aws_lb.api[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api[0].certificate_arn

  # Anything that is not the API gets a plain 404 and reaches nothing.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "api_forward" {
  count        = local.api_count
  listener_arn = aws_lb_listener.api_https[0].arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[0].arn
  }

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }
}

# ------------------------------------------------------------------------------------------------
# Firewall. Managed rule groups in block mode, plus a per-address ceiling. No logging and no sampled requests:
# both keep request data (the Authorization header, query strings) outside the application. A false positive on a real route
# is fixed with a scoped exclusion on that one rule, never by switching a group off.
# ------------------------------------------------------------------------------------------------
resource "aws_wafv2_web_acl" "api" {
  count = local.api_count
  name  = "${local.name}-api"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "per-address-ceiling"
    priority = 5
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit                 = var.api_rate_limit_per_5min
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-api-ceiling"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "ip-reputation"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-api-ip-reputation"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "known-bad-inputs"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-api-known-bad-inputs"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "common"
    priority = 30
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-api-common"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-api"
    sampled_requests_enabled   = false
  }
}

resource "aws_wafv2_web_acl_association" "api" {
  count        = local.api_count
  resource_arn = aws_lb.api[0].arn
  web_acl_arn  = aws_wafv2_web_acl.api[0].arn
}

# ------------------------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------------------------
output "api_alb_dns_name" {
  description = "Cloudflare: a DNS-only CNAME from the API name to this value."
  value       = var.enable_api_hosting ? aws_lb.api[0].dns_name : null
}

output "api_validation_cnames" {
  description = "Add these certificate validation records in Cloudflare, DNS-only; keep them for renewal."
  value       = var.enable_api_hosting ? aws_acm_certificate.api[0].domain_validation_options : []
}

output "api_target_group_arn" {
  description = "Where the service (F3b) registers its tasks."
  value       = var.enable_api_hosting ? aws_lb_target_group.api[0].arn : null
}

output "api_tasks_security_group_id" {
  description = "The security group of the API tasks (F3b)."
  value       = var.enable_api_hosting ? aws_security_group.api_tasks[0].id : null
}
