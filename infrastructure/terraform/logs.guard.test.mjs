// Guards for the log groups AWS services write on our behalf: the database's exported logs and the password-change notifier's (database.tf, lambda.tf,
// kms.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it. Audit finding INF-12.
// A log group nobody declares is created by the service on first write, with no expiry and no customer key, and Terraform never sees it. So each one is
// declared here with a retention and the service-logs key, and the database must not start before its groups exist.
// Like the other guards it reads Terraform TEXT. `logsProblems` returns what is wrong with a copy of the text (empty when nothing is); the tests run it on
// the real files and on deliberately broken copies, so every rule has been seen to fail. The notifier's own package checks the alarm pattern against the
// lines its handler really writes (infrastructure/lambda/password-change-notifier/src/handler.test.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const files = { database: read('./database.tf'), lambda: read('./lambda.tf'), kms: read('./kms.tf') };

const squash = (s) => s.replace(/[ \t]+/g, ' ');
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

function blocks(text, header) {
  const found = [];
  const re = new RegExp(header, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let i = text.indexOf('{', m.index);
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) break;
    }
    found.push(text.slice(start, i + 1));
  }
  return found;
}

export function logsProblems({ database, lambda, kms }) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  const has = (text, s) => squash(code(text)).includes(squash(s));
  const one = (text, header) => blocks(code(text), header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))[0] ?? '';

  // One key for the logs AWS services write for us. Only the log service may use it, and only for these groups.
  const keyPolicy = one(kms, 'data "aws_iam_policy_document" "service_logs_key"');
  need(keyPolicy !== '', 'the service-logs key needs its own key policy');
  need(!/identifiers\s*=\s*\["\*"\]/.test(keyPolicy) && has(keyPolicy, 'identifiers = ["logs.${var.region}.amazonaws.com"]'), 'only the CloudWatch Logs service may use the service-logs key');
  need(has(keyPolicy, 'variable = "kms:EncryptionContext:aws:logs:arn"') && has(keyPolicy, 'for name in local.service_log_groups'), 'the service-logs key may be used for the declared service log groups only');
  const key = one(kms, 'resource "aws_kms_key" "service_logs"');
  need(has(key, 'enable_key_rotation = true') && has(key, 'deletion_window_in_days = local.kms_deletion_days') && has(key, 'policy = data.aws_iam_policy_document.service_logs_key.json'), 'the service-logs key must rotate, use the profile deletion window and carry its own policy');

  // The database's exported logs: one declared group per export, from the same list, before the instance exists.
  need(has(database, 'enabled_cloudwatch_logs_exports = local.rds_log_exports'), 'the instance must export exactly the list the log groups are made from');
  need(has(database, 'rds_log_exports = ["postgresql", "upgrade"]'), 'the database must export its postgresql and upgrade logs');
  const rds = one(database, 'resource "aws_cloudwatch_log_group" "rds"');
  need(has(rds, 'for_each = toset(local.rds_log_exports)') && has(rds, 'name = "/aws/rds/instance/${local.name}/${each.value}"'), 'every exported database log must have a declared group at the name RDS writes to');
  need(has(rds, 'retention_in_days = 365') && has(rds, 'kms_key_id = aws_kms_key.service_logs.arn'), 'the database log groups must expire after 365 days and be encrypted with the service-logs key');
  need(has(one(database, 'resource "aws_db_instance" "main"'), 'depends_on = [aws_cloudwatch_log_group.rds]'), 'the database must not start before its log groups exist, or RDS creates them without expiry or key');

  // The notifier's log group: encrypted, and its two "a notice was lost" lines raise an alarm.
  const group = one(lambda, 'resource "aws_cloudwatch_log_group" "password_notifier"');
  need(has(group, 'kms_key_id = aws_kms_key.service_logs.arn') && has(group, 'retention_in_days = 90'), 'the notifier log group must be encrypted with the service-logs key and keep its 90 days');
  need(has(group, 'name = local.password_notifier_log_group'), 'the notifier log group must be named by the same local the key policy allows');
  const filter = one(lambda, 'resource "aws_cloudwatch_log_metric_filter" "password_notice_lost"');
  const pattern = /pattern\s*=\s*"(.*)"\s*$/m.exec(filter)?.[1].replace(/\\"/g, '"') ?? '';
  need(pattern === '?"password_change_notice_failed" ?"password_change_notice_skipped"', 'the filter must match both lines the notifier writes when a notice is lost (term match: Lambda prefixes each line, so a JSON selector never matches)');
  need(has(filter, 'log_group_name = aws_cloudwatch_log_group.password_notifier.name'), 'the filter must read the notifier log group');
  const alarm = one(lambda, 'resource "aws_cloudwatch_metric_alarm" "password_notice_lost"');
  need(has(alarm, 'alarm_actions = [aws_sns_topic.audit_alarms.arn]'), 'a lost password-change notice must notify the audit topic');
  need(has(alarm, 'threshold = 1') && has(alarm, 'comparison_operator = "GreaterThanOrEqualToThreshold"') && has(alarm, 'treat_missing_data = "notBreaching"') && has(alarm, 'statistic = "Sum"'), 'one lost notice must raise the alarm; silence is normal');
  need(has(filter, 'namespace = local.auth_metrics') && has(alarm, 'namespace = local.auth_metrics') && has(filter, 'name = "PasswordNoticesLost"') && has(alarm, 'metric_name = "PasswordNoticesLost"'), 'the alarm must read the metric the filter writes');
  return problems;
}

test('the service log groups have no problems (and the scan found the files: a floor, so an empty read cannot pass)', () => {
  assert.ok(files.database.includes('resource "aws_db_instance" "main"') && files.lambda.includes('resource "aws_lambda_function" "password_notifier"'));
  assert.deepEqual(logsProblems(files), []);
});

test('the service log guard reports each way the text could be weakened (controls)', () => {
  const weakened = [
    ['database', 'no group for the exported logs', /resource "aws_cloudwatch_log_group" "rds" \{[\s\S]*?\n\}\n/, ''],
    ['database', 'the groups never expire', /(resource "aws_cloudwatch_log_group" "rds" \{[\s\S]*?)retention_in_days = 365/, '$1retention_in_days = 0'],
    ['database', 'the groups use the AWS-owned key', /(resource "aws_cloudwatch_log_group" "rds" \{[\s\S]*?)kms_key_id\s+= aws_kms_key\.service_logs\.arn\n/, '$1'],
    ['database', 'a group at a name RDS does not write to', '/aws/rds/instance/${local.name}/${each.value}', '/aws/rds/${local.name}/${each.value}'],
    ['database', 'the database may start first', /\n\s+depends_on = \[aws_cloudwatch_log_group\.rds\]\n/, '\n'],
    ['database', 'an export with no declared group', 'enabled_cloudwatch_logs_exports       = local.rds_log_exports', 'enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade", "iam-db-auth-error"]'],
    ['database', 'the upgrade log no longer exported', 'rds_log_exports = ["postgresql", "upgrade"]', 'rds_log_exports = ["postgresql"]'],
    ['kms', 'the key does not rotate', /(resource "aws_kms_key" "service_logs" \{[\s\S]*?)enable_key_rotation\s+= true/, '$1enable_key_rotation     = false'],
    ['kms', 'anyone may use the key', 'identifiers = ["logs.${var.region}.amazonaws.com"]', 'identifiers = ["*"]'],
    ['kms', 'the key serves any log group', /for name in local\.service_log_groups[^\]]*\]/, '"*"]'],
    ['lambda', 'the notifier group unencrypted', /(resource "aws_cloudwatch_log_group" "password_notifier" \{[\s\S]*?)\s+kms_key_id\s+= aws_kms_key\.service_logs\.arn/, '$1'],
    ['lambda', 'the notifier group renamed away from the key policy', 'name              = local.password_notifier_log_group', 'name              = "/aws/lambda/${local.name}-notifier"'],
    ['lambda', 'the filter misses a failed send', '?\\"password_change_notice_failed\\" ', ''],
    ['lambda', 'the filter misses a skipped notice', ' ?\\"password_change_notice_skipped\\"', ''],
    ['lambda', 'the filter is a JSON selector', '?\\"password_change_notice_failed\\" ?\\"password_change_notice_skipped\\"', '{ $.event = \\"password_change_notice_failed\\" }'],
    ['lambda', 'the alarm tells nobody', /(resource "aws_cloudwatch_metric_alarm" "password_notice_lost" \{[\s\S]*?)alarm_actions\s+= \[aws_sns_topic\.audit_alarms\.arn\]/, '$1alarm_actions       = []'],
    ['lambda', 'the alarm needs five lost notices', /(resource "aws_cloudwatch_metric_alarm" "password_notice_lost" \{[\s\S]*?)threshold\s+= 1\n/, '$1threshold           = 5\n'],
    ['lambda', 'the alarm reads another metric', 'metric_name         = "PasswordNoticesLost"', 'metric_name         = "PasswordNotices"'],
  ];
  for (const [file, name, from, to] of weakened) {
    const broken = files[file].replace(from, to);
    assert.notEqual(broken, files[file], `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(logsProblems({ ...files, [file]: broken }).length > 0, `a weakened text must be reported: ${name}`);
  }
});
