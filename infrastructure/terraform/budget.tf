# A monthly cost budget for the account (observability plan A6, founder decision OB4, 2026-11-11). Nothing is created until the founder sets
# monthly_budget_usd: the figure is the founder's, not a default. budget.guard.test.mjs keeps these rules.
#
# It emails alarm_email directly instead of publishing to the alarm topic. That topic is encrypted with the audit key, and letting AWS Budgets
# publish to it would mean granting the Budgets service use of that key; an email subscriber needs no grant. The address is the one the alarm
# topic already emails. Budgets measures the whole account, so in staging it covers everything the stack runs.

variable "monthly_budget_usd" {
  description = "Monthly cost budget for the account, in US dollars. Null (the default) creates no budget. Alerts at 50%, 80% and 100% of actual spend and at 100% of forecast spend go to alarm_email."
  type        = number
  default     = null
  validation {
    condition     = var.monthly_budget_usd == null || (coalesce(var.monthly_budget_usd, 0) >= 1 && coalesce(var.monthly_budget_usd, 0) <= 100000)
    error_message = "monthly_budget_usd must be between 1 and 100000 US dollars, or null for no budget."
  }
}

locals {
  budget_count = var.monthly_budget_usd == null ? 0 : 1
  # Actual spend at each share of the budget, then the month's forecast passing it: the forecast warns before the money is spent.
  budget_actual_percents = [50, 80, 100]
}

resource "aws_budgets_budget" "monthly" {
  count        = local.budget_count
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = format("%.2f", coalesce(var.monthly_budget_usd, 0))
  limit_unit   = "USD"

  dynamic "notification" {
    for_each = local.budget_actual_percents
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alarm_email]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alarm_email]
  }
}
