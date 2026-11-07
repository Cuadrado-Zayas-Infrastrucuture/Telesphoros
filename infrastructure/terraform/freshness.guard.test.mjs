// Guards for the daily staging freshness check (freshness.tf, spec 027 PR 4). Run with: node --test infrastructure/terraform/freshness.guard.test.mjs
// (also part of `pnpm test:infra`). They read the Terraform as text and run on the real file and on deliberately broken copies, so every rule has been seen
// to fail. What this cannot prove: what AWS accepts, or that the email arrives (that is the founder's first run after the apply, spec 027 T016 and T017).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const real = read('./freshness.tf');
const kms = read('./kms.tf');

const block = (text, header) => {
  const start = text.indexOf(header);
  if (start < 0) return '';
  const next = text.slice(start + header.length).search(/\n(?:resource|data|locals|variable|output) /);
  return text.slice(start, next < 0 ? undefined : start + header.length + next);
};
const squash = (s) => s.replace(/\s+/g, ' ');

/** Each way the file departs from the design, as text. */
export function problems(tf, kmsText = kms) {
  const out = [];
  const need = (ok, why) => { if (!ok) out.push(why); };
  const has = (b, s) => squash(b).includes(squash(s));

  need(has(tf, 'freshness_count   = local.synthetic && local.api_service_count == 1 && local.web_count == 1 ? 1 : 0'), 'the check exists only under the synthetic profile with the API and the web distribution');

  const policy = block(tf, 'data "aws_iam_policy_document" "staging_freshness"');
  const actions = [...policy.matchAll(/actions\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  const allowed = ['logs:CreateLogStream', 'logs:PutLogEvents', 'ecs:DescribeServices', 'ecs:DescribeTaskDefinition', 'cloudwatch:DescribeAlarms', 'cloudfront:GetDistribution', 'sns:Publish', 'kms:GenerateDataKey*', 'kms:Decrypt'];
  need(actions.length === allowed.length && allowed.every((a) => actions.includes(a)), `the role may do exactly: ${allowed.join(', ')} (found: ${actions.join(', ') || 'none'})`);
  need(!actions.some((a) => /^(?:\*|[a-z0-9-]+:\*)$/.test(a)), 'no wildcard action');
  need(!actions.some((a) => /:(?:Put|Create|Delete|Update|Run|Start|Stop|Invoke|Tag|Set)/.test(a.replace('logs:CreateLogStream', '').replace('logs:PutLogEvents', ''))), 'the role changes nothing but its own logs');
  const starResources = [...policy.matchAll(/statement \{[\s\S]*?\n  \}/g)].filter((m) => /resources\s*=\s*\["\*"\]/.test(m[0])).map((m) => /sid\s*=\s*"([^"]+)"/.exec(m[0])?.[1]);
  need(JSON.stringify(starResources) === JSON.stringify(['ReadTaskDefinitionsAndAlarms']), `only the two calls that take no resource use "*" (found: ${starResources.join(', ') || 'none'})`);
  need(has(policy, 'resources = [aws_sns_topic.audit_alarms.arn]') && has(policy, 'actions   = ["sns:Publish"]'), 'it publishes to the audit alarm topic and nowhere else');
  need(has(policy, 'resources = [aws_kms_key.audit.arn]') && has(policy, 'variable = "kms:ViaService"') && has(policy, 'values   = ["sns.${var.region}.amazonaws.com"]'), 'the audit key is usable only through SNS');
  need(has(policy, 'resources = [aws_ecs_service.api[0].id, aws_ecs_service.worker[0].id]'), 'it reads the two services and no others');
  need(has(policy, 'resources = [aws_cloudfront_distribution.web[0].arn]'), 'it reads the one distribution');

  const group = block(tf, 'resource "aws_cloudwatch_log_group" "staging_freshness"');
  need(has(group, 'name              = local.freshness_log_group') && has(group, 'kms_key_id        = aws_kms_key.service_logs.arn') && has(group, 'retention_in_days = 90'), 'the log group is named by the local the key policy allows, encrypted, and kept 90 days');
  need(/freshness_log_group[^\n]*\]\)/.test(kmsText) && kmsText.includes('local.freshness_log_group]'), 'kms.tf lets the service-logs key encrypt the freshness log group');

  const fn = block(tf, 'resource "aws_lambda_function" "staging_freshness"');
  need(has(fn, 'runtime          = "nodejs22.x"') && has(fn, 'handler          = "index.handler"') && has(fn, 'timeout          = 60'), 'node 22, index.handler, a 60 second limit');
  need(has(fn, 'READY_URL       = "https://${var.api_domain}/api/v1/ready"'), 'it reads the real readiness path');
  need(!/(?:SECRET|PASSWORD|TOKEN|KEY)\s*=/.test(fn.replace(/DISTRIBUTION_ID|ALARM_PREFIX/g, '')), 'no secret in its environment');

  need(has(block(tf, 'resource "aws_cloudwatch_event_rule" "staging_freshness"'), 'schedule_expression = "cron(0 12 * * ? *)"'), 'it runs daily at 12:00 UTC');
  const perm = block(tf, 'resource "aws_lambda_permission" "events_invokes_staging_freshness"');
  need(has(perm, 'principal     = "events.amazonaws.com"') && has(perm, 'source_arn    = aws_cloudwatch_event_rule.staging_freshness[0].arn'), 'only this rule may invoke it');

  need(has(block(tf, 'resource "aws_cloudwatch_log_metric_filter" "freshness_run_complete"'), 'pattern        = "\\"staging-freshness-ran\\" \\"outcome=complete\\""'), 'the filter counts the complete line only');
  const missed = block(tf, 'resource "aws_cloudwatch_metric_alarm" "freshness_check_missed"');
  need(has(missed, 'evaluation_periods  = 26') && has(missed, 'datapoints_to_alarm = 26') && has(missed, 'period              = 3600'), 'the missed-run alarm waits 26 hours');
  need(has(missed, 'treat_missing_data  = "breaching"') && has(missed, 'comparison_operator = "LessThanThreshold"') && has(missed, 'threshold           = 1'), 'a missing complete line is a breach');
  need(has(missed, 'alarm_actions       = [aws_sns_topic.audit_alarms.arn]'), 'the missed-run alarm reaches the audit topic');
  const failing = block(tf, 'resource "aws_cloudwatch_metric_alarm" "freshness_check_failing"');
  need(has(failing, 'metric_name         = "Errors"') && has(failing, 'comparison_operator = "GreaterThanOrEqualToThreshold"') && has(failing, 'alarm_actions       = [aws_sns_topic.audit_alarms.arn]'), 'any Lambda error alarms to the audit topic');
  need(has(failing, 'dimensions          = { FunctionName = aws_lambda_function.staging_freshness[0].function_name }'), 'the errors alarm watches this function');
  return out;
}

test('freshness.tf follows the design', () => {
  assert.ok(real.length > 3000, 'a scan that reads almost nothing proves nothing');
  assert.deepEqual(problems(real), []);
});

test('each rule fails on a deliberately broken copy (controls)', () => {
  const breaks = [
    ['runs outside the synthetic profile', 'local.synthetic && local.api_service_count', 'local.api_service_count'],
    ['a write action', '"sns:Publish"]', '"sns:Publish", "ecs:UpdateService"]'],
    ['a wildcard action', 'actions   = ["cloudfront:GetDistribution"]', 'actions   = ["cloudfront:*"]'],
    ['a star resource on a publish', 'resources = [aws_sns_topic.audit_alarms.arn]', 'resources = ["*"]'],
    ['the key without the SNS condition', 'values   = ["sns.${var.region}.amazonaws.com"]', 'values   = ["s3.${var.region}.amazonaws.com"]'],
    ['the wrong readiness path', '/api/v1/ready', '/ready'],
    ['a log group the key policy does not allow', 'name              = local.freshness_log_group', 'name              = "/aws/lambda/other"'],
    ['an unencrypted log group', 'kms_key_id        = aws_kms_key.service_logs.arn', 'retention_in_days = 90'],
    ['a different schedule', 'cron(0 12 * * ? *)', 'cron(0 12 ? * MON *)'],
    ['any principal may invoke', 'principal     = "events.amazonaws.com"', 'principal     = "*"'],
    ['the filter counts incomplete runs too', '\\"outcome=complete\\"', '\\"outcome=\\"'],
    ['a short missed-run window', 'evaluation_periods  = 26', 'evaluation_periods  = 2'],
    ['missing data is fine', 'treat_missing_data  = "breaching"', 'treat_missing_data  = "notBreaching"'],
    ['the errors alarm goes nowhere', /(freshness_check_failing" \{[\s\S]*?)alarm_actions       = \[aws_sns_topic\.audit_alarms\.arn\]/, '$1alarm_actions       = []'],
  ];
  for (const [name, from, to] of breaks) {
    const broken = real.replace(from, to);
    assert.notEqual(broken, real, `the replacement for "${name}" did not apply`);
    assert.ok(problems(broken).length > 0, name);
  }
  assert.ok(problems(real, kms.replace(', local.freshness_log_group]', ']')).length > 0, 'kms.tf not naming the freshness log group');
});
