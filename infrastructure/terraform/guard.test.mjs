// Run with: node --test infrastructure/terraform/
// A cheap tripwire: if someone edits a security-critical Cognito setting, this fails and forces a conversation.
// It reads the Terraform text; it does not (and cannot) prove what AWS will do once applied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import './api-compute.guard.test.mjs';
import './api.guard.test.mjs';
import './audit.guard.test.mjs';
import './web.guard.test.mjs';

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

test('strong passwords and email-only recovery', () => {
  has(cognito, 'minimum_length = 14');
  for (const rule of ['require_lowercase', 'require_uppercase', 'require_numbers', 'require_symbols']) has(cognito, `${rule} = true`);
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

const ALLOWED_BREAK_GLASS_ACTIONS = new Set(['s3:ListBucketVersions', 's3:GetObjectVersion', 's3:DeleteObjectVersion']);

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
  for (const s of permissionStatements) {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    if (s.Effect !== 'Allow') problems.push('permission statements must be Allow');
    for (const action of actions) {
      if (!ALLOWED_BREAK_GLASS_ACTIONS.has(action)) problems.push(`unexpected action ${action}`);
      if (action === 's3:DeleteObjectVersion') deletes += 1;
    }
    const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    for (const resource of resources) {
      if (typeof resource !== 'string' || !resource.startsWith('arn:aws:s3:::<REPORTS_BUCKET>')) problems.push(`resource ${resource} is not the reports bucket`);
    }
  }
  if (deletes !== 1) problems.push('s3:DeleteObjectVersion must be granted exactly once');
  return problems;
}

const runbookBlocks = [...readFileSync(new URL('../../docs/ops/break-glass.md', import.meta.url), 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));

test('the break-glass runbook text: one named principal with fresh MFA, and only list/inspect/delete on the reports bucket', () => {
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
  ];
  for (const [name, change] of weakened) {
    const t = copy(trust);
    const p = copy(permissions);
    change(t, p);
    assert.ok(breakGlassProblems(t, p).length > 0, `a weakened text must be reported: ${name}`);
  }
  assert.deepEqual(breakGlassProblems(copy(trust), copy(permissions)), []); // control: unchanged copies are clean
});
