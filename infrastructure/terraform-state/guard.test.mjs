import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const file = new URL('./main.tf', import.meta.url);
const source = existsSync(file) ? readFileSync(file, 'utf8') : '';

function problems(text) {
  text = text.replace(/^\s*#.*$/gm, '');
  const required = [
    ['public access', /block_public_acls\s*=\s*true/],
    ['public policy', /block_public_policy\s*=\s*true/],
    ['ignore public ACLs', /ignore_public_acls\s*=\s*true/],
    ['restrict public buckets', /restrict_public_buckets\s*=\s*true/],
    ['ownership', /object_ownership\s*=\s*"BucketOwnerEnforced"/],
    ['encryption', /sse_algorithm\s*=\s*"aws:kms"/],
    ['key binding', /kms_master_key_id\s*=\s*aws_kms_key\.state\.arn/],
    ['rotation', /enable_key_rotation\s*=\s*true/],
    ['destroy', /force_destroy\s*=\s*false/],
    ['TLS', /Sid\s*=\s*"DenyInsecureTransport"/],
    ['principal', /Sid\s*=\s*"DenyOtherPrincipals"/],
    ['state deletion', /Sid\s*=\s*"DenyStateDeletion"/],
    ['wrong key', /Sid\s*=\s*"DenyWrongKey"/],
    ['wrong encryption', /Sid\s*=\s*"DenyWrongEncryption"/],
    ['account', /allowed_account_ids\s*=\s*\[local\.account_id\]/],
    ['lockout safety', /bypass_policy_lockout_safety_check\s*=\s*false/],
  ];
  const errors = required.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label);
  // An enabled lifecycle rule must not mask suspended bucket versioning.
  const versioning = text.match(/resource "aws_s3_bucket_versioning" "state" \{([\s\S]*?)^\}/m)?.[1] ?? '';
  if (!/status\s*=\s*"Enabled"/.test(versioning)) errors.push('versioning');
  if ((text.match(/prevent_destroy\s*=\s*true/g) ?? []).length !== 2) errors.push('bucket/key deletion protection');
  if (/backend\s+"|module\s+"|data\s+"/.test(text)) errors.push('independent root');
  return errors;
}

test('the standalone state root retains encryption, access and deletion safeguards', () => {
  assert.deepEqual(problems(source), []);
});

const weakenings = [
  ['versioning', /status\s*=\s*"Enabled"/, 'status = "Suspended"'],
  ['public access', /block_public_acls\s*=\s*true/, 'block_public_acls = false'],
  ['public policy', /block_public_policy\s*=\s*true/, 'block_public_policy = false'],
  ['ignore public ACLs', /ignore_public_acls\s*=\s*true/, 'ignore_public_acls = false'],
  ['restrict public buckets', /restrict_public_buckets\s*=\s*true/, 'restrict_public_buckets = false'],
  ['ownership', /object_ownership\s*=\s*"BucketOwnerEnforced"/, 'object_ownership = "ObjectWriter"'],
  ['encryption', /sse_algorithm\s*=\s*"aws:kms"/, 'sse_algorithm = "AES256"'],
  ['key binding', /kms_master_key_id\s*=\s*aws_kms_key\.state\.arn/, 'kms_master_key_id = "other-key"'],
  ['rotation', /enable_key_rotation\s*=\s*true/, 'enable_key_rotation = false'],
  ['destroy', /force_destroy\s*=\s*false/, 'force_destroy = true'],
  ...['TLS', 'principal', 'state deletion', 'wrong key', 'wrong encryption'].map((label, i) => [
    label, new RegExp(`Sid\\s*=\\s*"${['DenyInsecureTransport', 'DenyOtherPrincipals', 'DenyStateDeletion', 'DenyWrongKey', 'DenyWrongEncryption'][i]}"`), 'Sid = "removed"',
  ]),
  ['account', /allowed_account_ids\s*=\s*\[local\.account_id\]/, 'allowed_account_ids = []'],
  ['lockout safety', /bypass_policy_lockout_safety_check\s*=\s*false/, 'bypass_policy_lockout_safety_check = true'],
  ['bucket/key deletion protection', /prevent_destroy\s*=\s*true/, 'prevent_destroy = false'],
];
for (const [label, pattern, replacement] of weakenings) {
  test(`rejects weakened ${label}`, () => {
    assert.match(source, pattern, 'the weakening must actually change the configuration');
    assert.ok(problems(source.replace(pattern, replacement)).includes(label));
  });
}

test('a backend or a coupled root cannot slip into the standalone package', () => {
  for (const addition of ['backend "s3" {}', 'module "main" {}', 'data "aws_caller_identity" "live" {}']) {
    assert.ok(problems(`${source}\n${addition}`).includes('independent root'));
  }
});

test('live configuration has no defaults and tests cannot contact a real provider or apply', () => {
  const variables = readFileSync(new URL('./variables.tf', import.meta.url), 'utf8');
  assert.equal((variables.match(/^variable "/gm) ?? []).length, 5);
  assert.equal((variables.match(/nullable\s*=\s*false/g) ?? []).length, 5);
  assert.doesNotMatch(variables, /\bdefault\s*=/);
  const files = readdirSync(new URL('.', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.tftest.hcl'));
  assert.equal(files.length, 2, 'cover the original native plans and the generated-policy fixture');
  for (const file of files) {
    const tests = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(tests, /mock_provider "aws"/, file);
    assert.doesNotMatch(tests, /^\s*provider\s+"|command\s*=\s*apply|override_module/m, file);
    assert.equal((tests.match(/^run "/gm) ?? []).length, (tests.match(/command\s*=\s*plan/g) ?? []).length, file);
  }
});
