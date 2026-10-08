// Run with: node --test infrastructure/terraform/
// A cheap tripwire: if someone edits a security-critical Cognito setting, this fails and forces a conversation.
// It reads the Terraform text; it does not (and cannot) prove what AWS will do once applied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
