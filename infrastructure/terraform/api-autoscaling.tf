# The API's autoscaling (Application Auto Scaling on the ECS service). NOT APPLIED. Exists with the API service (api-compute.tf).
#
# The service is always registered as a scalable target between api_desired_count (the floor) and api_max_count (the ceiling). With
# api_max_count null the two are equal and nothing scales: the target only holds the count. A CPU target-tracking policy is added when the
# ceiling is above the floor. Registering or updating a target moves the service's running count inside [floor, ceiling], so raising
# api_desired_count after the service exists takes effect through min_capacity; the service itself ignores desired_count changes so an apply
# never undoes a scale-out.
#
# Not scaled here: the worker (no queue-depth metric to scale on; one task is enough, worker.tf) and the issuer (enable_issuer, off).
# The connection budget (database-connections.tf) counts the API at its ceiling. api-autoscaling.guard.test.mjs keeps these rules.

variable "api_max_count" {
  description = "The most API tasks autoscaling may run. Null (the default) turns autoscaling off: the service runs api_desired_count tasks. Each task at the ceiling is counted in the database connection budget."
  type        = number
  default     = null
  validation {
    condition     = var.api_max_count == null || (var.api_max_count == floor(coalesce(var.api_max_count, 0)) && coalesce(var.api_max_count, 0) >= 1 && coalesce(var.api_max_count, 0) <= 10)
    error_message = "api_max_count must be a whole number from 1 to 10, or null."
  }
  validation {
    condition     = coalesce(var.api_max_count, var.api_desired_count) >= var.api_desired_count
    error_message = "api_max_count must not be below api_desired_count."
  }
}

variable "api_scale_cpu_target" {
  description = "The average CPU percentage across API tasks that autoscaling holds. A first guess: measure in staging."
  type        = number
  default     = 60
  validation {
    condition     = var.api_scale_cpu_target >= 20 && var.api_scale_cpu_target <= 90
    error_message = "api_scale_cpu_target must be between 20 and 90."
  }
}

locals {
  api_max_tasks = coalesce(var.api_max_count, var.api_desired_count)
}

resource "aws_appautoscaling_target" "api" {
  count              = local.api_service_count
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.api[0].name}/${aws_ecs_service.api[0].name}"
  min_capacity       = var.api_desired_count
  max_capacity       = local.api_max_tasks
}

resource "aws_appautoscaling_policy" "api_cpu" {
  count              = local.api_service_count == 1 && local.api_max_tasks > var.api_desired_count ? 1 : 0
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.api[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.api[0].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.api_scale_cpu_target
    scale_out_cooldown = 60  # add tasks quickly: a new task needs about a minute to pass /api/v1/ready
    scale_in_cooldown  = 300 # remove them slowly, so a short lull does not stop tasks a returning burst needs
    disable_scale_in   = false

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
