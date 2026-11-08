# The daily staging freshness check (spec 027, PR 4): a Lambda that compares what synthetic staging runs with docs/ops/staging-expected.json and
# lists the Terraform merged after the last apply, and emails the audit alarm topic when anything is stale or the check itself could not read
# something. Source: infrastructure/lambda/staging-freshness. A release plan builds it (scripts/staging/release/lib.sh build_lambdas); before
# any other plan, build it first under umask 022: pnpm --filter @telesphoros/staging-freshness build.
# Synthetic profile only, and only when the API (and so the worker) and the web distribution exist: there is nothing to compare otherwise.
# It reads, and publishes one message; it can change nothing. What is applied: docs/ops/environments.md.
locals {
  freshness_count   = local.synthetic && local.api_service_count == 1 && local.web_count == 1 ? 1 : 0
  freshness_metrics = "${local.name}/Freshness"
  # The two services by name, not by aws_ecs_service ids: every IMAGE release updates both services, and a policy document that reads their ids
  # is then read only at apply, so the plan shows this policy as "known after apply" and the release check refuses it (the 859e964a release).
  # The names are the cluster's and the services' in api-compute.tf and worker.tf; the freshness guard checks that they still agree.
  freshness_services = [for s in ["api", "worker"] : "arn:aws:ecs:${var.region}:${local.audit_account_id}:service/${local.name}-api/${local.name}-${s}"]
}

data "archive_file" "staging_freshness" {
  count       = local.freshness_count
  type        = "zip"
  source_dir  = "${path.module}/../lambda/staging-freshness/dist"
  output_path = "${path.module}/.build/staging-freshness.zip"
  excludes    = ["index.mjs.map"]
}

# The log group name is a local in kms.tf, because the service-logs key policy names the groups it may encrypt.
resource "aws_cloudwatch_log_group" "staging_freshness" {
  count             = local.freshness_count
  name              = local.freshness_log_group
  retention_in_days = 90
  kms_key_id        = aws_kms_key.service_logs.arn
}

resource "aws_iam_role" "staging_freshness" {
  count              = local.freshness_count
  name               = "${local.name}-staging-freshness"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "staging_freshness" {
  count = local.freshness_count
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.staging_freshness[0].arn}:*"]
  }
  statement {
    sid       = "ReadTheTwoServices"
    actions   = ["ecs:DescribeServices"]
    resources = local.freshness_services
  }
  # These two read calls accept no resource: ECS task definitions and CloudWatch alarms are named per call, not per ARN.
  statement {
    sid       = "ReadTaskDefinitionsAndAlarms"
    actions   = ["ecs:DescribeTaskDefinition", "cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadTheWebDistribution"
    actions   = ["cloudfront:GetDistribution"]
    resources = [aws_cloudfront_distribution.web[0].arn]
  }
  statement {
    sid       = "PublishToTheAlarmTopic"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.audit_alarms.arn]
  }
  # The topic is encrypted with the audit key; its policy delegates to IAM through the account root statement (audit.tf, AccountAdministration).
  statement {
    sid       = "UseTheAuditKeyForTheTopicOnly"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = [aws_kms_key.audit.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["sns.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "staging_freshness" {
  count  = local.freshness_count
  name   = "check-and-publish"
  role   = aws_iam_role.staging_freshness[0].id
  policy = data.aws_iam_policy_document.staging_freshness[0].json
}

resource "aws_lambda_function" "staging_freshness" {
  count            = local.freshness_count
  function_name    = "${local.name}-staging-freshness"
  role             = aws_iam_role.staging_freshness[0].arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.staging_freshness[0].output_path
  source_code_hash = data.archive_file.staging_freshness[0].output_base64sha256
  timeout          = 60
  memory_size      = 128

  environment {
    variables = {
      ECS_CLUSTER     = aws_ecs_cluster.api[0].name
      API_SERVICE     = aws_ecs_service.api[0].name
      WORKER_SERVICE  = aws_ecs_service.worker[0].name
      ALARM_PREFIX    = local.name
      DISTRIBUTION_ID = aws_cloudfront_distribution.web[0].id
      TOPIC_ARN       = aws_sns_topic.audit_alarms.arn
      READY_URL       = "https://${var.api_domain}/api/v1/ready"
    }
  }

  depends_on = [aws_cloudwatch_log_group.staging_freshness, aws_iam_role_policy.staging_freshness]
}

# Once a day, 12:00 UTC (08:00 in San Juan).
resource "aws_cloudwatch_event_rule" "staging_freshness" {
  count               = local.freshness_count
  name                = "${local.name}-staging-freshness"
  description         = "Runs the daily staging freshness check."
  schedule_expression = "cron(0 12 * * ? *)"
}

resource "aws_cloudwatch_event_target" "staging_freshness" {
  count = local.freshness_count
  rule  = aws_cloudwatch_event_rule.staging_freshness[0].name
  arn   = aws_lambda_function.staging_freshness[0].arn
}

# Only THIS rule may invoke it.
resource "aws_lambda_permission" "events_invokes_staging_freshness" {
  count         = local.freshness_count
  statement_id  = "AllowTheDailyRule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.staging_freshness[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.staging_freshness[0].arn
}

# A COMPLETE run writes "staging-freshness-ran outcome=complete ..." (handler.ts). Lambda writes each console line behind a timestamp, request id
# and level, so CloudWatch sees plain text: this is a term match, and the handler's test keeps it in step with the line. An incomplete run does not
# match, so a check that keeps failing to read raises the missed-run alarm as well as emailing.
resource "aws_cloudwatch_log_metric_filter" "freshness_run_complete" {
  count          = local.freshness_count
  name           = "${local.name}-freshness-run-complete"
  log_group_name = aws_cloudwatch_log_group.staging_freshness[0].name
  pattern        = "\"staging-freshness-ran\" \"outcome=complete\""
  metric_transformation {
    name      = "FreshnessChecksComplete"
    namespace = local.freshness_metrics
    value     = "1"
  }
}

# No complete run for 26 hours (a daily run plus two hours). Missing data counts as a breach, so a function that never runs at all is caught.
resource "aws_cloudwatch_metric_alarm" "freshness_check_missed" {
  count               = local.freshness_count
  alarm_name          = "${local.name}-freshness-check-missed"
  alarm_description   = "The daily staging freshness check has not completed for 26 hours: staging could be stale with nobody told. docs/ops/environments.md."
  namespace           = local.freshness_metrics
  metric_name         = "FreshnessChecksComplete"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 26
  datapoints_to_alarm = 26
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.freshness_run_complete]
}

# Any error: a read that threw outside the check's own handling, or an email that could not be published.
resource "aws_cloudwatch_metric_alarm" "freshness_check_failing" {
  count               = local.freshness_count
  alarm_name          = "${local.name}-freshness-check-failing"
  alarm_description   = "The daily staging freshness check failed (for example it could not publish its email). Read its log group."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.staging_freshness[0].function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.audit_alarms.arn]
}
