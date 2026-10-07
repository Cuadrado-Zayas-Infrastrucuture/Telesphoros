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

test('the three roles exist as Cognito groups', () => {
  has(cognito, 'roles = ["reader", "clinician", "admin"]');
});

test('the notifier is invokable only by this user pool and may send only as the verified sender', () => {
  has(lambda, 'principal = "cognito-idp.amazonaws.com"');
  has(lambda, 'source_arn = aws_cognito_user_pool.main.arn');
  has(lambda, 'actions = ["ses:SendEmail"]');
  has(lambda, 'resources = [aws_sesv2_email_identity.from.arn]');
  lacks(lambda, /resources\s*=\s*\["\*"\]/, 'no wildcard resources');
});
