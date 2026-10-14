# ------------------------------------------------------------------------------------------------
# Authentication: Amazon Cognito. Invite-only, MFA required, short-lived tokens.
# NOT APPLIED. Cognito is covered by the AWS BAA only once it is executed for the account.
# ------------------------------------------------------------------------------------------------

locals {
  roles = ["reader", "clinician", "admin", "reviewer"]
}

# Invitations, reset codes and the password-change notice are sent through SES (HIPAA-eligible,
# and not subject to Cognito's small default email quota).
resource "aws_sesv2_email_identity" "from" {
  email_identity = var.ses_from_email
}

resource "aws_cognito_user_pool" "main" {
  name = local.name

  # People sign in with their email address.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  username_configuration {
    case_sensitive = false
  }

  deletion_protection = local.cognito_protection

  # No public sign-up. Accounts exist only because an administrator invited them.
  admin_create_user_config {
    allow_admin_create_user_only = true
    invite_message_template {
      email_subject = "Your Telesphoros invitation"
      email_message = "You have been invited to Telesphoros. Your username is {username} and your temporary password is {####}. It expires in 3 days. You will be asked to choose a new password and set up an authenticator app."
      sms_message   = "Telesphoros: username {username}, temporary password {####}."
    }
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }

  # Multi-factor is mandatory, with an authenticator app only. SMS codes are phishable and SIM-swappable.
  mfa_configuration = "ON"
  software_token_mfa_configuration {
    enabled = true
  }

  # A forgotten password is recovered by email only, never by SMS.
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Telesphoros verification code"
    email_message        = "Your Telesphoros verification code is {####}. It expires soon. If you did not ask for it, ignore this email and tell your administrator."
  }

  email_configuration {
    email_sending_account = "DEVELOPER"
    source_arn            = aws_sesv2_email_identity.from.arn
    from_email_address    = var.ses_from_email
  }

  lambda_config {
    # Emails the owner when a password is reset (Cognito does not do this itself).
    post_confirmation = aws_lambda_function.password_notifier.arn
  }
}

# Role groups. Since M1.5 the API takes a person's roles from its own membership table (docs/auth.md) and ignores these groups; they remain only as a
# convenience for administrators in the console. The tenant:<id> group is still read, and must agree with the membership row.
resource "aws_cognito_user_group" "role" {
  for_each     = toset(local.roles)
  name         = each.value
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Telesphoros role: ${each.value}"
}

# The browser app: a public client (a browser cannot keep a secret), authorization-code flow with PKCE.
resource "aws_cognito_user_pool_client" "spa" {
  name         = "${local.name}-app"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.app_callback_urls
  logout_urls                          = var.app_logout_urls

  # Short-lived access tokens bound how long a stolen or revoked token can be used.
  # The app keeps NO refresh token; the minimum Cognito allows is one hour.
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 1

  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED" # "wrong password" and "no such user" look the same
  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH"]

  read_attributes  = ["email", "email_verified"]
  write_attributes = [] # users cannot change their own attributes (such as email) through the API
}

# The sign-in page: https://<prefix>.auth.<region>.amazoncognito.com
resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}
