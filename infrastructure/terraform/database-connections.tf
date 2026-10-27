# The database connection budget. NOT APPLIED. Nothing here changes the database: it refuses a plan whose services could open more
# connections than the instance accepts.
#
# Every process that connects, at its largest count (desired_count is the most tasks a service runs until autoscaling is added):
#   API task       DATABASE_POOL_MAX (api_db_pool_max) application connections + 3 for the ledger verifier (apps/backend/src/ledger/verifier.ts)
#   worker task    WORKER_CONCURRENCY + 3 (apps/worker/src/main.ts)
#   issuer task    4 (apps/backend/src/issuer/issuer-core.ts)
#   migration task 1, while it runs
# A deploy starts each service's new tasks before it stops the old ones (deployment_maximum_percent = 200 on all three), so the services are
# counted at that peak; the migration task runs once, before the deploy.
# database-connections.guard.test.mjs keeps these numbers in agreement with the code.

variable "api_db_pool_max" {
  type        = number
  default     = 10
  description = "DATABASE_POOL_MAX: the most connections one API task holds as the application login. The backend's default is the same 10."
  validation {
    condition     = var.api_db_pool_max == floor(var.api_db_pool_max) && var.api_db_pool_max >= 1 && var.api_db_pool_max <= 50
    error_message = "api_db_pool_max must be a whole number from 1 to 50."
  }
}

variable "db_connection_budget" {
  type        = number
  default     = null
  description = "The connections the instance accepts for the application's logins: SHOW max_connections on the live instance, minus its reserved superuser slots. Null uses the estimate for db_instance_class below, which production refuses."
  validation {
    condition     = var.db_connection_budget == null || (var.db_connection_budget == floor(coalesce(var.db_connection_budget, 0)) && coalesce(var.db_connection_budget, 0) >= 10 && coalesce(var.db_connection_budget, 0) <= 5000)
    error_message = "db_connection_budget must be a whole number from 10 to 5000, or null."
  }
}

locals {
  worker_concurrency = 4

  # ESTIMATES, NOT READINGS. AWS's default max_connections for RDS for PostgreSQL is LEAST({DBInstanceClassMemory/9531392}, 5000), and
  # DBInstanceClassMemory is the listed memory LESS what the operating system and RDS reserve (by an amount AWS does not publish per class).
  # Each estimate is floor(listed bytes / 9531392 x 0.65) - 5: a 35% margin for that reservation, and 5 for the reserved superuser slots.
  # Replace with db_connection_budget from a live SHOW max_connections before production (which refuses an estimate).
  connection_estimates = {
    "db.t4g.micro"  = 68
    "db.t4g.small"  = 141
    "db.t4g.medium" = 287
    "db.t4g.large"  = 580
  }
  connection_budget = var.db_connection_budget != null ? var.db_connection_budget : lookup(local.connection_estimates, local.db_instance_class, null)

  connection_deploy_peak_percent = 200

  connection_demand = (
    ceil((
      local.api_service_count * var.api_desired_count * (var.api_db_pool_max + 3)
      + local.api_service_count * var.worker_desired_count * (local.worker_concurrency + 3)
      + local.issuer_service_count * var.issuer_desired_count * 4
    ) * local.connection_deploy_peak_percent / 100)
    + local.api_service_count * 1
  )
}

output "db_connection_demand" {
  description = "The most connections the hosted services can open together during a deploy, and the budget they are checked against (an estimate unless db_connection_budget is set)."
  value       = { demand = local.connection_demand, budget = local.connection_budget, budget_is_estimate = var.db_connection_budget == null }
}
