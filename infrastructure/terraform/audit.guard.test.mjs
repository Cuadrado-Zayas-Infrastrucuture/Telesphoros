// Guards for the audit trail (audit.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads Terraform TEXT: it cannot prove what AWS will do once applied. `auditProblems` returns what is wrong with a
// copy of the text (empty when nothing is); the tests run it on the real file and on deliberately broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const audit = readFileSync(new URL('./audit.tf', import.meta.url), 'utf8');
const iam = readFileSync(new URL('./iam.tf', import.meta.url), 'utf8');
const outputs = readFileSync(new URL('./outputs.tf', import.meta.url), 'utf8');
const squash = (s) => s.replace(/[ \t]+/g, ' ');
/** Terraform text without comment lines, so a rule is checked against what is configured and not against what is said about it. */
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** Every `block { ... }` whose header matches, by brace matching. */
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

const ALARMS = {
  ReportObjectDeleted: ['DeleteObjectVersion', 'DeleteObjects', 'aws_s3_bucket.reports.bucket'],
  BreakGlassRoleAssumed: ['AssumeRole', 'var.break_glass_role_name'],
  RootAccountUsed: ['$.userIdentity.type = \\"Root\\"'],
  AuditTrailChanged: ['StopLogging', 'DeleteTrail', 'UpdateTrail', 'PutEventSelectors'],
  DataBucketProtectionChanged: ['PutBucketPolicy', 'PutBucketPublicAccessBlock', 'PutObjectLockConfiguration', 'local.audit_buckets'],
  EncryptionKeyChanged: ['DisableKey', 'ScheduleKeyDeletion'],
};

/** What is wrong with the audit-trail Terraform text `tf` (and the application policy text `appIam`), as a list of sentences. */
export function auditProblems(tf, appIam = iam) {
  const problems = [];
  const text = code(tf);
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const has = (haystack, fragment) => squash(code(haystack)).includes(squash(fragment));
  const one = (header) => blocks(text, header)[0] ?? '';

  // The log bucket: private, versioned, locked, encrypted with the audit key.
  const bucket = one('resource "aws_s3_bucket" "audit"');
  need(has(bucket, 'object_lock_enabled = true'), 'the audit bucket must have Object Lock enabled');
  need(has(bucket, 'force_destroy = local.synthetic'), 'the audit bucket may be force-destroyable only through the synthetic profile (profile.tf), never by a literal');
  need(!/force_destroy\s*=\s*true/.test(bucket), 'the audit bucket must not be force-destroyable by a literal');
  const access = one('resource "aws_s3_bucket_public_access_block" "audit"');
  for (const flag of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) need(has(access, `${flag} = true`), `public access must stay blocked (${flag})`);
  need(has(one('resource "aws_s3_bucket_versioning" "audit"'), 'status = "Enabled"'), 'the audit bucket must be versioned');
  need(has(one('resource "aws_s3_bucket_ownership_controls" "audit"'), 'object_ownership = "BucketOwnerEnforced"'), 'ACLs must be disabled on the audit bucket');
  const lock = one('resource "aws_s3_bucket_object_lock_configuration" "audit"');
  need(has(lock, 'mode = var.audit_lock_mode') && has(lock, 'days = local.audit_lock_days'), 'the lock must use the mode variable and the profile days (the variable in production), not literals that can drift');
  const sse = one('resource "aws_s3_bucket_server_side_encryption_configuration" "audit"');
  need(has(sse, 'sse_algorithm = "aws:kms"') && has(sse, 'kms_master_key_id = aws_kms_key.audit.arn'), 'logs must be encrypted with the dedicated audit key');
  const lifecycle = one('resource "aws_s3_bucket_lifecycle_configuration" "audit"');
  need(has(lifecycle, 'days = var.audit_log_retention_days') && has(lifecycle, 'noncurrent_days = var.audit_log_retention_days'), 'expiry must use the retention variable');

  // The variables: the six-year floor and a governance default.
  const retention = one('variable "audit_log_retention_days"');
  need(Number(/default\s*=\s*(\d+)/.exec(retention)?.[1]) >= 2190, 'the default retention is below the six-year floor (2190 days)');
  need(has(retention, 'condition = var.audit_log_retention_days >= 2190'), 'the retention variable must refuse values below 2190');
  const mode = one('variable "audit_lock_mode"');
  need(has(mode, 'default = "GOVERNANCE"'), 'the lock mode must default to GOVERNANCE (COMPLIANCE is irreversible and a separate decision)');
  need(has(mode, 'contains(["GOVERNANCE", "COMPLIANCE"], var.audit_lock_mode)'), 'the lock mode must be validated');
  need(has(one('variable "audit_lock_days"'), 'var.audit_lock_days <= var.audit_log_retention_days'), 'the lock must not outlast the retention');
  const email = one('variable "alarm_email"');
  need(email !== '' && !/default\s*=/.test(email), 'the alarm address must have no default (a real address belongs in tfvars)');

  // The bucket policy: only CloudTrail (for this trail) may write; insecure and old TLS denied; nobody gets a wildcard allow.
  const policy = one('data "aws_iam_policy_document" "audit_bucket"');
  need(has(policy, 'variable = "aws:SecureTransport"') && has(policy, 'variable = "s3:TlsVersion"'), 'the bucket policy must deny insecure transport and TLS below 1.2');
  for (const statement of blocks(policy, 'statement ')) {
    if (/effect\s*=\s*"Deny"/.test(statement)) continue;
    need(has(statement, 'identifiers = ["cloudtrail.amazonaws.com"]'), 'an Allow statement on the audit bucket must be for CloudTrail only');
    need(has(statement, 'variable = "aws:SourceArn"') && has(statement, 'values = [local.audit_trail_arn]'), 'an Allow statement on the audit bucket must name this trail');
    need(!/identifiers\s*=\s*\["\*"\]/.test(statement), 'no wildcard principal may be allowed on the audit bucket');
  }
  need(has(policy, 'resources = ["${aws_s3_bucket.audit.arn}/AWSLogs/${local.audit_account_id}/*"]'), 'CloudTrail may write only under this account\'s prefix');

  // The key: rotation on; only CloudTrail, CloudWatch Logs and CloudWatch (and the account) get anything; nothing for the application.
  need(has(one('resource "aws_kms_key" "audit"'), 'enable_key_rotation = true'), 'the audit key must rotate');
  const keyPolicy = one('data "aws_iam_policy_document" "audit_key"');
  need(!/identifiers\s*=\s*\["\*"\]/.test(keyPolicy), 'the audit key policy must not allow a wildcard principal');
  const trailStatement = blocks(keyPolicy, 'statement ').find((s) => s.includes('GenerateDataKey') && s.includes('cloudtrail.amazonaws.com')) ?? '';
  need(has(trailStatement, 'variable = "aws:SourceArn"') && has(trailStatement, 'values = [local.audit_trail_arn]'), 'CloudTrail may use the key only for this trail');
  need(!/aws_kms_key\.audit/.test(code(appIam)), 'the application policies must not be able to use the audit key');

  // The trail itself.
  const trail = one('resource "aws_cloudtrail" "audit"');
  need(has(trail, 'is_multi_region_trail = !local.synthetic'), 'the trail must cover every region (single-Region only through the synthetic profile)');
  need(has(trail, 'include_global_service_events = true'), 'the trail must include global service events');
  need(has(trail, 'enable_log_file_validation = true'), 'log file validation (signed digests) must be on');
  need(has(trail, 'kms_key_id = aws_kms_key.audit.arn'), 'the trail must encrypt with the audit key');
  const selector = blocks(trail, 'event_selector')[0] ?? '';
  need(has(selector, 'read_write_type = "All"'), 'data events must cover both reads and writes');
  need(has(selector, 'include_management_events = true'), 'management events must be recorded');
  need(has(selector, 'type = "AWS::S3::Object"') && has(selector, 'values = ["${aws_s3_bucket.reports.arn}/"]'), 'S3 data events must cover every object in the reports bucket');

  // The alarms.
  const topic = one('resource "aws_sns_topic" "audit_alarms"');
  need(has(topic, 'kms_master_key_id = aws_kms_key.audit.arn'), 'the alarm topic must be encrypted with the audit key');
  need(has(one('resource "aws_sns_topic_subscription" "audit_alarms_email"'), 'endpoint = var.alarm_email'), 'the subscription must use the variable, not a hard-coded address');
  const alarm = one('resource "aws_cloudwatch_metric_alarm" "audit"');
  need(has(alarm, 'for_each = local.audit_alarms') && has(alarm, 'alarm_actions = [aws_sns_topic.audit_alarms.arn]'), 'every alarm must notify the audit topic');
  need(has(alarm, 'threshold = 1') && has(alarm, 'comparison_operator = "GreaterThanOrEqualToThreshold"'), 'a single occurrence must alarm');
  need(has(alarm, 'treat_missing_data = "notBreaching"'), 'no data must not alarm');
  need(has(one('resource "aws_cloudwatch_log_metric_filter" "audit"'), 'for_each = local.audit_alarms'), 'every alarm needs its metric filter');
  need(has(text, 'audit_buckets = concat([aws_s3_bucket.reports.bucket, aws_s3_bucket.audit.bucket], aws_s3_bucket.backups[*].bucket)'), 'the bucket-protection alarm must watch the reports, audit and (when it exists) backup buckets');
  const alarms = one('audit_alarms = ');
  for (const [name, fragments] of Object.entries(ALARMS)) {
    const entry = blocks(alarms, `${name} = `)[0] ?? '';
    need(entry !== '', `the ${name} alarm is missing`);
    for (const fragment of fragments) need(entry.includes(fragment), `the ${name} alarm must look for ${fragment}`);
  }
  return problems;
}

test('the audit trail text has no problems (and the scan found the file: a floor, so an empty read cannot pass)', () => {
  assert.ok(audit.length > 5000 && audit.includes('resource "aws_cloudtrail" "audit"'));
  assert.deepEqual(auditProblems(audit), []);
});

test('the outputs let later alarms reuse the audit topic', () => {
  assert.ok(code(outputs).includes('output "audit_alarm_topic_arn"') && code(outputs).includes('aws_sns_topic.audit_alarms.arn'));
});

test('the audit guard reports each way the text could be weakened (controls)', () => {
  const weakened = [
    ['Object Lock removed', 'object_lock_enabled = true', 'object_lock_enabled = false'],
    ['public access allowed', 'block_public_policy     = true', 'block_public_policy     = false'],
    ['versioning suspended', 'status = "Enabled"', 'status = "Suspended"'],
    ['lock days a literal', 'days = local.audit_lock_days', 'days = 1'],
    ['logs not encrypted with the audit key', 'kms_master_key_id = aws_kms_key.audit.arn\n    }\n    bucket_key_enabled', 'kms_master_key_id = aws_kms_key.data.arn\n    }\n    bucket_key_enabled'],
    ['retention floor lowered', 'default     = 2190', 'default     = 365'],
    ['retention validation removed', 'condition     = var.audit_log_retention_days >= 2190', 'condition     = true'],
    ['compliance mode by default', 'default     = "GOVERNANCE"', 'default     = "COMPLIANCE"'],
    ['alarm address hard-coded', 'description = "Where audit alarms are emailed (an SNS subscription the owner must confirm). No default on purpose: set it in your tfvars."\n  type        = string', 'description = "x"\n  type        = string\n  default     = "someone@example.com"'],
    ['insecure transport allowed', 'variable = "aws:SecureTransport"', 'variable = "aws:Other"'],
    ['anyone may write logs', 'identifiers = ["cloudtrail.amazonaws.com"]\n    }\n    condition {\n      test     = "StringEquals"\n      variable = "aws:SourceArn"\n      values   = [local.audit_trail_arn]\n    }\n    condition {\n      test     = "StringEquals"\n      variable = "s3:x-amz-acl"', 'identifiers = ["*"]\n    }\n    condition {\n      test     = "StringEquals"\n      variable = "aws:SourceArn"\n      values   = [local.audit_trail_arn]\n    }\n    condition {\n      test     = "StringEquals"\n      variable = "s3:x-amz-acl"'],
    ['writes allowed for any prefix', '/AWSLogs/${local.audit_account_id}/*', '/*'],
    ['key rotation off', 'enable_key_rotation     = true\n  deletion_window_in_days = local.kms_deletion_days\n  policy', 'enable_key_rotation     = false\n  deletion_window_in_days = local.kms_deletion_days\n  policy'],
    ['not multi-region', 'is_multi_region_trail         = !local.synthetic', 'is_multi_region_trail         = false'],
    ['log validation off', 'enable_log_file_validation    = true', 'enable_log_file_validation    = false'],
    ['reads not recorded', 'read_write_type           = "All"', 'read_write_type           = "WriteOnly"'],
    ['data events dropped', 'values = ["${aws_s3_bucket.reports.arn}/"]', 'values = ["arn:aws:s3"]'],
    ['topic not encrypted', 'kms_master_key_id = aws_kms_key.audit.arn\n}\n\nresource "aws_sns_topic_subscription"', 'kms_master_key_id = "alias/aws/sns"\n}\n\nresource "aws_sns_topic_subscription"'],
    ['alarms notify nobody', 'alarm_actions       = [aws_sns_topic.audit_alarms.arn]', 'alarm_actions       = []'],
    ['missing data alarms', 'treat_missing_data  = "notBreaching"', 'treat_missing_data  = "breaching"'],
    ['version deletion not watched', '$.eventName = \\"DeleteObjectVersion\\"', '$.eventName = \\"Nothing\\"'],
    ['break-glass assumption not watched', '${var.break_glass_role_name}', 'some-other-role'],
    ['trail tampering not watched', '$.eventName = \\"StopLogging\\"', '$.eventName = \\"Nothing\\"'],
    ['key changes not watched', '$.eventName = \\"ScheduleKeyDeletion\\"', '$.eventName = \\"Nothing\\"'],
    ['backup bucket not watched', 'aws_s3_bucket.audit.bucket], aws_s3_bucket.backups[*].bucket)', 'aws_s3_bucket.audit.bucket], [])'],
    ['audit bucket force-destroyable by a literal', 'force_destroy       = local.synthetic', 'force_destroy       = true'],
    ['bucket-protection alarm ignores the list', 'for b in local.audit_buckets', 'for b in []'],
  ];
  for (const [name, from, to] of weakened) {
    assert.ok(audit.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(auditProblems(audit.replace(from, to)).length > 0, `a weakened text must be reported: ${name}`);
  }
  // The application policy must not be able to use the audit key.
  assert.ok(auditProblems(audit, `${iam}\nresource "x" "y" { arn = aws_kms_key.audit.arn }`).length > 0, 'the application using the audit key must be reported');
  assert.deepEqual(auditProblems(audit), []); // control: the unchanged text is clean
});
