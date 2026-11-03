# Existing hosted UI (classic) only. This does not migrate the domain or change its feature plan.
variable "enable_cognito_classic_branding" {
  description = "Apply reviewed classic hosted-UI branding to the browser client only. Confirm the live domain is version 1 before enabling."
  type        = bool
  default     = false
}

# A reviewed read-only DescribeUserPoolDomain result, not a setting that changes the domain.
variable "cognito_branding_observed_login_version" {
  description = "ManagedLoginVersion observed on the target domain before review. Required with branding enabled; this value does not migrate the domain."
  type        = number
  default     = null
  validation {
    condition     = var.cognito_branding_observed_login_version == null || contains([1, 2], var.cognito_branding_observed_login_version)
    error_message = "Use the observed Cognito branding version (1 or 2), or null when branding is disabled."
  }
}

resource "aws_cognito_user_pool_ui_customization" "spa" {
  count = var.enable_cognito_classic_branding ? 1 : 0

  user_pool_id = aws_cognito_user_pool.main.id
  client_id    = aws_cognito_user_pool_client.spa.id
  css          = file("${path.module}/cognito/hosted-ui.css")
  image_file   = filebase64("${path.module}/../../apps/frontend/src/assets/telesphoros-shield-rx.png")

  depends_on = [aws_cognito_user_pool_domain.main]

  lifecycle {
    precondition {
      condition     = var.cognito_branding_observed_login_version == 1 && aws_cognito_user_pool_domain.main.managed_login_version == 1
      error_message = "Classic branding requires a reviewed observed version-1 Cognito domain and a version-1 plan. Do not switch login versions or feature plans as part of a branding change."
    }
  }
}
