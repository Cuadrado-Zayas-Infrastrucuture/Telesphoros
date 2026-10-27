// Run with: node --test infrastructure/terraform/
// A cheap tripwire: if someone edits a security-critical Cognito setting, this fails and forces a conversation.
// It reads the Terraform text; it does not (and cannot) prove what AWS will do once applied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import './backend.guard.test.mjs';
import './api-compute.guard.test.mjs';
import './api-autoscaling.guard.test.mjs';
import './api.guard.test.mjs';
import './audit.guard.test.mjs';
import './profile.guard.test.mjs';
import './staging.guard.test.mjs';
import '../../scripts/staging/check-plan.test.mjs';
import './registry.guard.test.mjs';
import './web.guard.test.mjs';
import './worker.guard.test.mjs';
import './issuer.guard.test.mjs';
import './entrypoint.guard.test.mjs';
import './logs.guard.test.mjs';
import './database-alarms.guard.test.mjs';
import './database-connections.guard.test.mjs';
import './signing.guard.test.mjs';
import './reports-cors.guard.test.mjs';
import '../../scripts/staging/publish-frontend.test.mjs';
import '../../scripts/staging/run-task.test.mjs';
import '../../scripts/staging/verify-image.test.mjs';

const cognito = readFileSync(new URL('./cognito.tf', import.meta.url), 'utf8');
const lambda = readFileSync(new URL('./lambda.tf', import.meta.url), 'utf8');
const squash = (s) => s.replace(/[ \t]+/g, ' ');
const has = (text, fragment) => assert.ok(squash(text).includes(squash(fragment)), `expected to find: ${fragment}`);
const lacks = (text, pattern, why) => assert.ok(!pattern.test(text), why);

test('no public sign-up: accounts exist only by invitation', () => {
  has(cognito, 'allow_admin_create_user_only = true');
});

test('multi-factor is required, authenticator app only (no SMS)', () => {
  has(cognito, 'mfa_configuration = "ON"');
  has(cognito, 'software_token_mfa_configuration {\n    enabled = true');
  lacks(cognito, /sms_configuration|sms_authentication_message|"SMS_MFA"/i, 'SMS multi-factor must not be configured');
});

test('length-based passwords (no composition rules) and email-only recovery', () => {
  has(cognito, 'minimum_length = 15');
  for (const rule of ['require_lowercase', 'require_uppercase', 'require_numbers', 'require_symbols']) has(cognito, `${rule} = false`);
  has(cognito, 'name = "verified_email"');
  lacks(cognito, /name\s*=\s*"verified_phone_number"/, 'recovery by SMS must not be enabled');
});

test('the browser client is public, uses the code flow only, and has short-lived tokens', () => {
  has(cognito, 'generate_secret = false');
  has(cognito, 'allowed_oauth_flows = ["code"]');
  lacks(cognito, /"implicit"|ALLOW_USER_PASSWORD_AUTH|ALLOW_ADMIN_USER_PASSWORD_AUTH|ALLOW_CUSTOM_AUTH/, 'implicit flow and password-in-the-app flows must stay off');
  has(cognito, 'access_token_validity = 15');
  has(cognito, 'id_token_validity = 15');
  has(cognito, 'enable_token_revocation = true');
  has(cognito, 'prevent_user_existence_errors = "ENABLED"');
  has(cognito, 'write_attributes = []');
});

test('the four roles exist as Cognito groups', () => {
  has(cognito, 'roles = ["reader", "clinician", "admin", "reviewer"]');
});

test('the notifier is invokable only by this user pool and may send only as the verified sender', () => {
  has(lambda, 'principal = "cognito-idp.amazonaws.com"');
  has(lambda, 'source_arn = aws_cognito_user_pool.main.arn');
  has(lambda, 'actions = ["ses:SendEmail"]');
  has(lambda, 'resources = [aws_sesv2_email_identity.from.arn]');
  lacks(lambda, /resources\s*=\s*\["\*"\]/, 'no wildcard resources');
});

// ---- Report evidence (slice 5B-3.2a) --------------------------------------------------------------------------------------------
const storage = readFileSync(new URL('./storage.tf', import.meta.url), 'utf8');
const iam = readFileSync(new URL('./iam.tf', import.meta.url), 'utf8');
const variables = readFileSync(new URL('./variables.tf', import.meta.url), 'utf8');
/** Terraform text without comment lines, so a rule is checked against what is configured and not against what is said about it. */
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** The text of every `block { ... }` whose header matches, found by brace matching (not regex nesting). */
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

test('a pinned report file cannot expire as a noncurrent version before the six-year floor', () => {
  const [rule] = blocks(storage, 'resource "aws_s3_bucket_lifecycle_configuration" "reports"');
  assert.ok(rule, 'the reports lifecycle configuration must exist');
  const [expiry] = blocks(rule, 'noncurrent_version_expiration');
  assert.ok(expiry, 'the reports bucket must set a noncurrent expiration explicitly');
  assert.ok(/noncurrent_days\s*=\s*var\.reports_noncurrent_retention_days/.test(expiry), 'use the variable, not a literal that can drift below the floor');
  const [variable] = blocks(variables, 'variable "reports_noncurrent_retention_days"');
  assert.ok(variable, 'the retention variable must exist');
  const def = Number(/default\s*=\s*(\d+)/.exec(variable)?.[1]);
  assert.ok(def >= 2190, `default ${def} is below the six-year floor (2190 days)`);
  has(variable, 'condition     = var.reports_noncurrent_retention_days >= 2190');
});

test('the reports bucket keeps versions, and the application may read an exact version but never delete one', () => {
  const [versioning] = blocks(storage, 'resource "aws_s3_bucket_versioning" "reports"');
  has(versioning, 'status = "Enabled"');
  has(iam, '"s3:GetObjectVersion"');
  has(iam, '"s3:GetBucketVersioning"');
  lacks(code(iam), /s3:Delete|s3:\*/, 'the application policy must not be able to delete or administer objects');
});

/**
 * What is wrong with the evidence lock on the reports bucket (founder decision 2026-10-19: six years, GOVERNANCE), as a list of sentences.
 * The deny statements must be guarded by "the header is present": the application uploads WITHOUT an encryption header (it relies on the
 * bucket default), so an unguarded StringNotEquals would refuse every upload it makes.
 */
export function reportsLockProblems(storageText, variablesText) {
  const problems = [];
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const s = code(storageText);
  const contains = (text, fragment) => squash(text).includes(squash(fragment));
  const [bucket = ''] = blocks(s, 'resource "aws_s3_bucket" "reports"');
  need(contains(bucket, 'object_lock_enabled = true'), 'the reports bucket must be created with Object Lock (it cannot be added later)');
  const [lock = ''] = blocks(s, 'resource "aws_s3_bucket_object_lock_configuration" "reports"');
  need(contains(lock, 'mode = "GOVERNANCE"'), 'report versions must be locked in GOVERNANCE mode (founder decision 2026-10-19)');
  need(contains(lock, 'days = local.reports_lock_days'), 'the lock must use the profile days (the variable in production), not a literal that can drift');
  const [variable = ''] = blocks(code(variablesText), 'variable "reports_lock_days"');
  need(Number(/default\s*=\s*(\d+)/.exec(variable)?.[1]) >= 2190, 'the default report lock is below the six-year floor (2190 days)');
  need(contains(variable, 'condition = var.reports_lock_days >= 2190'), 'the report lock variable must refuse values below 2190');
  const [policy = ''] = blocks(s, 'data "aws_iam_policy_document" "reports_bucket"');
  const statement = (sid) => blocks(policy, 'statement ').find((st) => contains(st, `sid = "${sid}"`)) ?? '';
  const guarded = (st, variableName) => blocks(st, 'condition').some((c) => contains(c, 'test = "Null"') && contains(c, `variable = "${variableName}"`) && contains(c, 'values = ["false"]'));
  for (const [sid, variableName, wrong] of [
    ['DenyOtherEncryption', 's3:x-amz-server-side-encryption', 'values = ["aws:kms"]'],
    ['DenyOtherKey', 's3:x-amz-server-side-encryption-aws-kms-key-id', 'values = [aws_kms_key.data.arn]'],
  ]) {
    const st = statement(sid);
    need(contains(st, 'effect = "Deny"') && contains(st, 'actions = ["s3:PutObject"]'), `${sid} must deny PutObject`);
    need(guarded(st, variableName), `${sid} must apply only when the header is present (Null = false), or it refuses every application upload`);
    need(contains(st, 'test = "StringNotEquals"') && contains(st, wrong), `${sid} must refuse anything but the data key's encryption`);
  }
  const ssec = statement('DenyCustomerKeys');
  need(contains(ssec, 'effect = "Deny"') && guarded(ssec, 's3:x-amz-server-side-encryption-customer-algorithm'), 'customer-supplied keys (SSE-C) must be refused');
  return problems;
}

test('every report version is locked for six years and only the data key may encrypt it', () => {
  assert.deepEqual(reportsLockProblems(storage, variables), []);
});

test('the report-lock guard reports each way the text could be weakened (controls)', () => {
  const weakened = [
    ['Object Lock not enabled', ['storage', '  object_lock_enabled = true\n}', '}']],
    ['COMPLIANCE instead of the decided GOVERNANCE', ['storage', 'mode = "GOVERNANCE"\n      days = local.reports_lock_days', 'mode = "COMPLIANCE"\n      days = local.reports_lock_days']],
    ['lock days a literal', ['storage', 'days = local.reports_lock_days', 'days = 30']],
    ['floor lowered', ['variables', 'condition     = var.reports_lock_days >= 2190', 'condition     = var.reports_lock_days >= 1']],
    ['wrong-encryption deny unguarded (would refuse every upload)', ['storage', 'test     = "Null"\n      variable = "s3:x-amz-server-side-encryption"\n', 'test     = "Bool"\n      variable = "s3:x-amz-server-side-encryption"\n']],
    ['wrong-key deny accepts any key', ['storage', 'values   = [aws_kms_key.data.arn]', 'values   = ["*"]']],
    ['customer keys allowed', ['storage', 'sid       = "DenyCustomerKeys"\n    effect    = "Deny"', 'sid       = "DenyCustomerKeys"\n    effect    = "Allow"']],
  ];
  for (const [name, [which, from, to]] of weakened) {
    const source = which === 'storage' ? storage : variables;
    assert.ok(source.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    const [s, v] = which === 'storage' ? [storage.replace(from, to), variables] : [storage, variables.replace(from, to)];
    assert.ok(reportsLockProblems(s, v).length > 0, `a weakened text must be reported: ${name}`);
  }
  assert.deepEqual(reportsLockProblems(storage, variables), []); // control: the unchanged text is clean
});

/**
 * What would stop, or weaken, the backup job's upload to the off-site bucket, as a list of sentences (audit 2026-10-27, I1-I3).
 * The uploader sends NO encryption header by default (docs/ops/offsite-backups.md) and relies on the bucket default (the backup key), so
 * every deny on a request header must be guarded by "the header is present". Every upload also sets Object Lock retention, which S3
 * authorizes as s3:PutObjectRetention on top of s3:PutObject.
 */
export function backupUploadProblems(storageText, iamText) {
  const problems = [];
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const contains = (text, fragment) => squash(text).includes(squash(fragment));
  const s = code(storageText);
  const [sse = ''] = blocks(s, 'resource "aws_s3_bucket_server_side_encryption_configuration" "backups"');
  need(contains(sse, 'kms_master_key_id = aws_kms_key.backup[0].arn'), 'the backups bucket must encrypt by default with the backup key (a header-less upload relies on it)');
  const [policy = ''] = blocks(s, 'data "aws_iam_policy_document" "backups_bucket"');
  const statements = blocks(policy, 'statement ');
  const statement = (sid) => statements.find((st) => contains(st, `sid = "${sid}"`)) ?? '';
  const nullIs = (st, variableName, value) =>
    blocks(st, 'condition').some((c) => contains(c, 'test = "Null"') && contains(c, `variable = "${variableName}"`) && contains(c, `values = ["${value}"]`));
  for (const st of statements) {
    for (const c of blocks(st, 'condition')) {
      const header = /variable\s*=\s*"(s3:x-amz-[^"]+)"/.exec(c)?.[1];
      if (header && contains(c, 'test = "StringNotEquals"'))
        need(nullIs(st, header, 'false'), `a deny on ${header} must apply only when the header is present (Null = false), or it refuses every header-less upload`);
    }
  }
  const deny = (sid) => contains(statement(sid), 'effect = "Deny"') && contains(statement(sid), 'actions = ["s3:PutObject"]');
  need(deny('DenyOtherEncryption') && contains(statement('DenyOtherEncryption'), 'values = ["aws:kms"]'), 'DenyOtherEncryption must refuse any encryption but aws:kms');
  need(
    deny('DenyOtherKey') && nullIs(statement('DenyOtherKey'), 's3:x-amz-server-side-encryption-aws-kms-key-id', 'false') && contains(statement('DenyOtherKey'), 'values = [aws_kms_key.backup[0].arn]'),
    'DenyOtherKey must refuse any named key but the backup key',
  );
  const managed = statement('DenyManagedKey');
  need(
    deny('DenyManagedKey') &&
      contains(managed, 'test = "StringEquals"') &&
      contains(managed, 'values = ["aws:kms"]') &&
      nullIs(managed, 's3:x-amz-server-side-encryption-aws-kms-key-id', 'true'),
    'DenyManagedKey must refuse aws:kms named without a key id (S3 would use the AWS-managed key, not ours)',
  );
  need(deny('DenyCustomerKeys') && nullIs(statement('DenyCustomerKeys'), 's3:x-amz-server-side-encryption-customer-algorithm', 'false'), 'customer-supplied keys (SSE-C) must be refused');
  const [job = ''] = blocks(code(iamText), 'data "aws_iam_policy_document" "backup_job"');
  const upload = blocks(job, 'statement').find((st) => contains(st, 'sid = "UploadBackups"')) ?? '';
  need(contains(upload, '"s3:PutObject"') && contains(upload, '"s3:PutObjectRetention"'), 'the backup job must hold s3:PutObjectRetention: every upload sets Object Lock retention');
  need(!/BypassGovernanceRetention|s3:Get|s3:List|s3:Delete|"s3:\*"/.test(job), 'the backup job stays write-only and cannot bypass a lock');
  return problems;
}

test('the backup job can upload to the off-site bucket, encrypted only with the backup key', () => {
  assert.deepEqual(backupUploadProblems(storage, iam), []);
});

test('the backup-upload guard reports each way the text could be weakened (controls)', () => {
  const weakened = [
    // Anchored on the backups resource: the reports bucket has the same condition text, and String.replace changes only the first match.
    [
      'wrong-encryption deny unguarded (refuses every header-less upload)',
      [
        'storage',
        'resources = ["${aws_s3_bucket.backups[0].arn}/*"]\n    principals {\n      type        = "*"\n      identifiers = ["*"]\n    }\n    condition {\n      test     = "Null"\n      variable = "s3:x-amz-server-side-encryption"\n',
        'resources = ["${aws_s3_bucket.backups[0].arn}/*"]\n    principals {\n      type        = "*"\n      identifiers = ["*"]\n    }\n    condition {\n      test     = "Bool"\n      variable = "s3:x-amz-server-side-encryption"\n',
      ],
    ],
    ['bucket default not the backup key', ['storage', 'kms_master_key_id = aws_kms_key.backup[0].arn', 'kms_master_key_id = aws_kms_key.data.arn']],
    ['any named key accepted', ['storage', 'values   = [aws_kms_key.backup[0].arn]', 'values   = ["*"]']],
    ['aws:kms without a key id allowed', ['storage', 'sid       = "DenyManagedKey"\n    effect    = "Deny"', 'sid       = "DenyManagedKey"\n    effect    = "Allow"']],
    ['customer keys allowed', ['storage', 'sid       = "DenyCustomerKeys"\n    effect    = "Deny"\n    actions   = ["s3:PutObject"]\n    resources = ["${aws_s3_bucket.backups[0].arn}/*"]', 'sid       = "DenyCustomerKeys"\n    effect    = "Allow"\n    actions   = ["s3:PutObject"]\n    resources = ["${aws_s3_bucket.backups[0].arn}/*"]']],
    ['retention permission dropped', ['iam', '["s3:PutObject", "s3:PutObjectRetention"]', '["s3:PutObject"]']],
    ['lock bypass granted', ['iam', '["s3:PutObject", "s3:PutObjectRetention"]', '["s3:PutObject", "s3:PutObjectRetention", "s3:BypassGovernanceRetention"]']],
  ];
  for (const [name, [which, from, to]] of weakened) {
    const source = which === 'storage' ? storage : iam;
    assert.ok(source.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    const [s, i] = which === 'storage' ? [storage.replace(from, to), iam] : [storage, iam.replace(from, to)];
    assert.ok(backupUploadProblems(s, i).length > 0, `a weakened text must be reported: ${name}`);
  }
  assert.deepEqual(backupUploadProblems(storage, iam), []); // control: the unchanged text is clean
});

test('the application may list a report\'s intake prefix (versions and multipart uploads) and only under reports/', () => {
  const [inventory] = blocks(code(iam), 'statement').filter((s) => /sid\s*=\s*"ReportIntakeInventory"/.test(s));
  assert.ok(inventory, 'the validated intake needs a listing statement');
  has(inventory, '"s3:ListBucketVersions"');
  has(inventory, '"s3:ListBucketMultipartUploads"');
  has(inventory, 'aws_s3_bucket.reports.arn]');
  assert.ok(/variable\s*=\s*"s3:prefix"/.test(inventory) && /values\s*=\s*\["reports\/\*"\]/.test(inventory), 'the listing must be limited to the reports/ prefix');
  lacks(inventory, /s3:Delete|s3:Put|s3:Get|"s3:\*"/, 'the listing statement grants nothing but listing');
});

test('no policy in this module grants deletion of object versions (a break-glass role outside this module is the only holder)', () => {
  for (const [name, text] of [['storage.tf', storage], ['iam.tf', iam], ['lambda.tf', lambda]]) {
    for (const statement of blocks(code(text), 'statement')) {
      const allows = !/effect\s*=\s*"Deny"/.test(statement);
      if (!allows) continue;
      assert.ok(!/s3:DeleteObjectVersion|s3:Delete\*|"s3:\*"/.test(statement), `${name}: an Allow statement must not grant version deletion or s3:*:\n${statement}`);
    }
  }
});

// ---- The break-glass runbook's policy text (docs/ops/break-glass.md) ----
// The role is described, not created. The text still must not drift into something dangerous, because it is what a person will paste.

// s3:BypassGovernanceRetention: every report version is under a GOVERNANCE lock (storage.tf), so deleting one needs the bypass right too.
const ALLOWED_BREAK_GLASS_ACTIONS = new Set(['s3:ListBucketVersions', 's3:GetObjectVersion', 's3:DeleteObjectVersion', 's3:BypassGovernanceRetention']);

/** What is wrong with a break-glass trust policy and permission policy (empty when nothing is). */
export function breakGlassProblems(trust, permissions) {
  const problems = [];
  const statements = (policy) => (Array.isArray(policy?.Statement) ? policy.Statement : []);
  const trustStatements = statements(trust);
  if (trustStatements.length !== 1) problems.push('the trust policy must have exactly one statement');
  for (const s of trustStatements) {
    const principal = s.Principal?.AWS;
    if (s.Effect !== 'Allow' || s.Action !== 'sts:AssumeRole') problems.push('the trust statement must allow sts:AssumeRole and nothing else');
    if (typeof principal !== 'string' || principal === '*' || /:root$/.test(principal)) problems.push('the trust must name exactly one principal, not * and not an account root');
    if (s.Condition?.Bool?.['aws:MultiFactorAuthPresent'] !== 'true') problems.push('the trust must require MFA');
    const age = Number(s.Condition?.NumericLessThan?.['aws:MultiFactorAuthAge']);
    if (!(age > 0 && age <= 3600)) problems.push('the trust must require MFA that is at most an hour old');
  }
  const permissionStatements = statements(permissions);
  if (permissionStatements.length === 0) problems.push('the permission policy has no statements');
  let deletes = 0;
  let bypasses = 0;
  for (const s of permissionStatements) {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    if (s.Effect !== 'Allow') problems.push('permission statements must be Allow');
    for (const action of actions) {
      if (!ALLOWED_BREAK_GLASS_ACTIONS.has(action)) problems.push(`unexpected action ${action}`);
      if (action === 's3:DeleteObjectVersion') deletes += 1;
      if (action === 's3:BypassGovernanceRetention') bypasses += 1;
    }
    if (actions.includes('s3:BypassGovernanceRetention') && !actions.includes('s3:DeleteObjectVersion')) problems.push('the lock bypass must sit in the same statement as the version delete, never on its own');
    const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    for (const resource of resources) {
      if (typeof resource !== 'string' || !resource.startsWith('arn:aws:s3:::<REPORTS_BUCKET>')) problems.push(`resource ${resource} is not the reports bucket`);
    }
  }
  if (deletes !== 1) problems.push('s3:DeleteObjectVersion must be granted exactly once');
  if (bypasses !== 1) problems.push('s3:BypassGovernanceRetention must be granted exactly once (the role cannot remove a locked version without it)');
  return problems;
}

const runbookBlocks = [...readFileSync(new URL('../../docs/ops/break-glass.md', import.meta.url), 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));

test('the break-glass runbook text: one named principal with fresh MFA, and only list/inspect/delete (with the lock bypass) on the reports bucket', () => {
  assert.equal(runbookBlocks.length, 2, 'expected the trust policy and the permission policy: a scan that finds none proves nothing');
  assert.deepEqual(breakGlassProblems(runbookBlocks[0], runbookBlocks[1]), []);
});

test('the break-glass check catches each way the text could be weakened (controls)', () => {
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const [trust, permissions] = runbookBlocks;
  const weakened = [
    ['no MFA', (t) => { delete t.Statement[0].Condition.Bool; }],
    ['stale MFA allowed', (t) => { t.Statement[0].Condition.NumericLessThan['aws:MultiFactorAuthAge'] = '86400'; }],
    ['anyone may assume it', (t) => { t.Statement[0].Principal.AWS = '*'; }],
    ['a whole account may assume it', (t) => { t.Statement[0].Principal.AWS = 'arn:aws:iam::123456789012:root'; }],
    ['two principals', (t) => { t.Statement[0].Principal.AWS = ['a', 'b']; }],
    ['s3 wildcard action', (_t, p) => { p.Statement[1].Action = ['s3:*']; }],
    ['kms decrypt added', (_t, p) => { p.Statement[1].Action.push('kms:Decrypt'); }],
    ['every bucket', (_t, p) => { p.Statement[1].Resource = '*'; }],
    ['a deny statement in place of an allow', (_t, p) => { p.Statement[0].Effect = 'Deny'; }],
    ['deletion granted twice', (_t, p) => { p.Statement[0].Action.push('s3:DeleteObjectVersion'); }],
    ['lock bypass granted twice', (_t, p) => { p.Statement[0].Action.push('s3:BypassGovernanceRetention'); }],
    ['lock bypass missing (the role could not do its job)', (_t, p) => { p.Statement[1].Action = p.Statement[1].Action.filter((a) => a !== 's3:BypassGovernanceRetention'); }],
  ];
  for (const [name, change] of weakened) {
    const t = copy(trust);
    const p = copy(permissions);
    change(t, p);
    assert.ok(breakGlassProblems(t, p).length > 0, `a weakened text must be reported: ${name}`);
  }
  assert.deepEqual(breakGlassProblems(copy(trust), copy(permissions)), []); // control: unchanged copies are clean
});
