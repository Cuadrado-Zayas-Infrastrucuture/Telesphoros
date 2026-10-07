# Password-change notifier: emails the account owner when a password is reset.
# Source: infrastructure/lambda/password-change-notifier (build it first: pnpm --filter @telesphoros/password-change-notifier build).

data "archive_file" "password_notifier" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/password-change-notifier/dist"
  output_path = "${path.module}/.build/password-change-notifier.zip"
  excludes    = ["index.mjs.map"]
}

resource "aws_cloudwatch_log_group" "password_notifier" {
  name              = "/aws/lambda/${local.name}-password-notifier"
  retention_in_days = 90
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "password_notifier" {
  name               = "${local.name}-password-notifier"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "password_notifier" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.password_notifier.arn}:*"]
  }
  # Only the one verified sender; it cannot send as anyone else.
  statement {
    sid       = "SendAsTheNoReplyAddress"
    actions   = ["ses:SendEmail"]
    resources = [aws_sesv2_email_identity.from.arn]
  }
}

resource "aws_iam_role_policy" "password_notifier" {
  name   = "send-notice"
  role   = aws_iam_role.password_notifier.id
  policy = data.aws_iam_policy_document.password_notifier.json
}

resource "aws_lambda_function" "password_notifier" {
  function_name    = "${local.name}-password-notifier"
  role             = aws_iam_role.password_notifier.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.password_notifier.output_path
  source_code_hash = data.archive_file.password_notifier.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      FROM_ADDRESS = var.ses_from_email
    }
  }

  depends_on = [aws_cloudwatch_log_group.password_notifier]
}

# Only THIS user pool may invoke it.
resource "aws_lambda_permission" "cognito_invokes_notifier" {
  statement_id  = "AllowCognitoUserPool"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.password_notifier.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
