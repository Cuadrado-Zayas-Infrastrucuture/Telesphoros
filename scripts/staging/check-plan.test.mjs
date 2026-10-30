import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IMAGE_POLICY_UPDATES, planProblems } from './check-plan.mjs';

const ACCOUNT = '123456789012';
const REGION = 'us-east-2';
const REPOSITORY = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/telesphoros-staging-api`;
const IMAGE = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/telesphoros-staging-api@sha256:${'0'.repeat(64)}`;
const MIGRATE_IMAGE = IMAGE.replace(/0{64}$/, '1'.repeat(64));
const KEY_ARN = `arn:aws:kms:${REGION}:${ACCOUNT}:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0`;
// What scripts/staging/verify-image.mjs writes after cosign verified IMAGE against the stack's key.
const RECORD = Object.freeze({ format: 1, method: 'signature', environment: 'staging', keyAlias: 'alias/telesphoros-staging-image-signing', keyArn: KEY_ARN,
  cosignVersion: 'v3.1.3', images: Object.freeze([IMAGE]), recordedAt: '2026-10-21T09:00:00.000Z' });
const policy = (repository) => JSON.stringify({ Version: '2012-10-17', Statement: [
  { Sid: 'EcrLogin', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
  { Sid: 'PullThisRepositoryOnly', Effect: 'Allow', Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], Resource: repository },
  { Sid: 'WriteOwnLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/ecs/synthetic:*` },
] });
function fixture(stage) {
  const create = { A: 'aws_ecs_cluster.api[0]', B: 'aws_s3_bucket.web[0]', C: 'aws_ecs_service.api[0]' }[stage];
  const changes = [{ address: create, mode: 'managed', change: { actions: ['create'], before: null, after: { name: 'synthetic' } } }];
  if (stage === 'C') for (const address of IMAGE_POLICY_UPDATES) changes.push({
    address, mode: 'managed', change: { actions: ['update'], before: { name: address, role: 'existing-role', policy: policy(`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/none`) }, after: { name: address, role: 'existing-role', policy: policy(REPOSITORY) }, after_unknown: {} },
  });
  return {
    format_version: '1.2', complete: true, applyable: true, errored: false,
    variables: Object.fromEntries(Object.entries({ name_prefix: 'telesphoros', deployment_profile: 'synthetic', environment: 'staging', enable_api_hosting: true, enable_web_hosting: stage !== 'A', api_image: stage === 'C' ? IMAGE : '', api_migrate_image: '', region: REGION }).map(([name, value]) => [name, { value }])),
    resource_changes: changes,
  };
}

test('staged plans accept create-only A/B and exactly the four repository-only updates in first-image C', () => {
  for (const stage of ['A', 'B', 'C']) {
    const plan = fixture(stage);
    plan.resource_changes.push({ address: 'data.aws_caller_identity.current', mode: 'data', change: { actions: ['read'] } });
    plan.resource_changes.push({ address: 'aws_s3_bucket.reports', mode: 'managed', change: { actions: ['no-op'] } });
    assert.deepEqual(planProblems(plan, stage, RECORD), []);
  }
});

test('saved -var boolean strings are accepted without treating arbitrary strings as true', () => {
  for (const stage of ['A', 'B', 'C']) {
    const plan = fixture(stage);
    plan.variables.enable_api_hosting.value = 'true';
    plan.variables.enable_web_hosting.value = stage === 'A' ? 'false' : 'true';
    assert.deepEqual(planProblems(plan, stage, RECORD), []);
    for (const invalid of ['yes', 'FALSE', '', null]) {
      plan.variables.enable_web_hosting.value = invalid;
      assert.ok(planProblems(plan, stage, RECORD).some((reason) => reason.includes('hosting switches')));
    }
  }
});

test('staged plans reject unrelated updates, every deletion/replacement, missing policy updates and incomplete plans', () => {
  const controls = [
    ['delete', (p) => { p.resource_changes[0].change.actions = ['delete']; }],
    ['replace', (p) => { p.resource_changes[0].change.actions = ['delete', 'create']; }],
    ['create-before-delete', (p) => { p.resource_changes[0].change.actions = ['create', 'delete']; }],
    ['unrelated update', (p) => { p.resource_changes[0].change.actions = ['update']; }],
    ['missing update', (p) => { p.resource_changes.pop(); }],
    ['unknown policy', (p) => { p.resource_changes[1].change.after_unknown.policy = true; }],
    ['changed role', (p) => { p.resource_changes[1].change.after.role = 'another-role'; }],
    ['import', (p) => { p.resource_changes[0].change.importing = { id: 'existing' }; }],
    ['drift', (p) => { p.resource_drift = [{ change: { actions: ['update'] } }]; }],
    ['duplicate address', (p) => { p.resource_changes.push(structuredClone(p.resource_changes[1])); }],
    ['empty plan', (p) => { p.resource_changes = []; }],
    ['incomplete', (p) => { p.complete = false; }],
    ['errored', (p) => { p.errored = true; }],
    ['not applicable', (p) => { p.applyable = false; }],
    ['wrong profile', (p) => { p.variables.deployment_profile.value = 'production'; }],
    ['wrong environment', (p) => { p.variables.environment.value = 'production'; }],
    ['wrong hosting', (p) => { p.variables.enable_api_hosting.value = false; }],
    ['wrong Region', (p) => { p.variables.region.value = 'us-west-2'; }],
    ['mutable image', (p) => { p.variables.api_image.value = IMAGE.replace(/@sha256:.+/, ':latest'); }],
  ];
  for (const [name, edit] of controls) {
    const plan = fixture('C'); edit(plan);
    assert.ok(planProblems(plan, 'C', RECORD).length > 0, name);
  }
  for (const stage of ['A', 'B']) {
    const plan = fixture(stage); plan.resource_changes.push(fixture('C').resource_changes[1]);
    assert.ok(planProblems(plan, stage, RECORD).some((reason) => reason.includes('unexpected action')), `${stage} remains create-only`);
    plan.variables.api_image.value = IMAGE;
    assert.ok(planProblems(plan, stage, RECORD).some((reason) => reason.includes('must have no api_image')));
  }
  for (const plan of [null, {}, { format_version: '2.0', resource_changes: [] }]) assert.ok(planProblems(plan, 'C', RECORD).length > 0);
  assert.ok(planProblems(fixture('C'), 'D').length > 0);
});

test('an allowed policy address does not permit any other IAM permission or resource change', () => {
  const edits = [
    ['wildcard repository', (p) => { p.Statement[1].Resource = '*'; }],
    ['different repository', (p) => { p.Statement[1].Resource = `${REPOSITORY}-other`; }],
    ['broader ECR actions', (p) => { p.Statement[1].Action = ['ecr:*']; }],
    ['extra log permission', (p) => { p.Statement[2].Action.push('logs:DeleteLogGroup'); }],
    ['extra statement', (p) => { p.Statement.push({ Effect: 'Allow', Action: '*', Resource: '*' }); }],
    ['duplicate pull statement', (p) => { p.Statement.push(structuredClone(p.Statement[1])); }],
  ];
  for (const address of IMAGE_POLICY_UPDATES) for (const [name, edit] of edits) {
    const plan = fixture('C'); const change = plan.resource_changes.find((entry) => entry.address === address).change;
    const parsed = JSON.parse(change.after.policy); edit(parsed); change.after.policy = JSON.stringify(parsed);
    assert.ok(planProblems(plan, 'C', RECORD).some((reason) => reason.includes('unexpected action')), `${address}: ${name}`);
  }
  const plan = fixture('C'); plan.resource_changes[1].change.before.policy = policy(REPOSITORY);
  assert.ok(planProblems(plan, 'C', RECORD).length > 0, 'this is only the first image transition from repository/none');
  plan.resource_changes[1].change.after.policy = 'not JSON';
  assert.ok(planProblems(plan, 'C', RECORD).length > 0);
});

test('stage C needs a verification record for exactly this stack, key and digest (INF-03 SC-001)', () => {
  assert.deepEqual(planProblems(fixture('C'), 'C', RECORD), []);
  const record = (edit) => { const r = structuredClone(RECORD); edit(r); return r; };
  const refused = [
    ['no record', undefined, /verified-image\.json/],
    ['an unreadable record', 'not an object', /verified-image\.json/],
    ['a record for another digest (unsigned, or signed for a different digest)', record((r) => { r.images = [MIGRATE_IMAGE]; }), /api_image .* has no verification/],
    ['a tag recorded instead of the digest', record((r) => { r.images = [IMAGE.replace(/@sha256:.+/, ':latest')]; }), /api_image .* has no verification/],
    ['a stale record format', record((r) => { r.format = 0; }), /format/],
    ['a newer record format', record((r) => { r.format = 2; }), /format/],
    ['another key (another stack\'s alias)', record((r) => { r.keyAlias = 'alias/telesphoros-production-image-signing'; }), /alias\/telesphoros-staging-image-signing/],
    ['another name prefix', record((r) => { r.keyAlias = 'alias/other-staging-image-signing'; }), /alias\/telesphoros-staging-image-signing/],
    ['a key ARN in another Region', record((r) => { r.keyArn = KEY_ARN.replace(REGION, 'us-west-2'); }), /key ARN/],
    ['a key ARN in another account', record((r) => { r.keyArn = KEY_ARN.replace(ACCOUNT, '210987654321'); }), /key ARN/],
    ['an alias recorded as the key', record((r) => { r.keyArn = `arn:aws:kms:${REGION}:${ACCOUNT}:alias/telesphoros-staging-image-signing`; }), /key ARN/],
    ['cosign 2', record((r) => { r.cosignVersion = 'v2.6.1'; }), /cosign 3/],
    ['another environment', record((r) => { r.environment = 'dev'; }), /environment/],
    ['an unknown method', record((r) => { r.method = 'trusted'; }), /method/],
    ['images not a list', record((r) => { r.images = IMAGE; }), /images/],
  ];
  for (const [name, value, pattern] of refused) {
    const problems = planProblems(fixture('C'), 'C', value);
    assert.ok(problems.some((reason) => pattern.test(reason)), `${name}: ${problems.join('; ')}`);
  }
  // api_migrate_image gets the same treatment: set and unverified is refused; set and verified is accepted.
  const plan = fixture('C'); plan.variables.api_migrate_image.value = MIGRATE_IMAGE;
  assert.ok(planProblems(plan, 'C', RECORD).some((reason) => /api_migrate_image .* has no verification/.test(reason)));
  assert.deepEqual(planProblems(plan, 'C', record((r) => { r.images = [IMAGE, MIGRATE_IMAGE]; })), []);
  // A and B have no image, so they need no record and ignore one.
  for (const stage of ['A', 'B']) {
    assert.deepEqual(planProblems(fixture(stage), stage), []);
    assert.deepEqual(planProblems(fixture(stage), stage, 'not an object'), []);
  }
});

test('stage C accepts a break-glass record for synthetic staging only, and says so', () => {
  const glass = { format: 1, method: 'break-glass', environment: 'staging', reason: 'CI down since 09:00, synthetic hotfix', images: [IMAGE], recordedAt: '2026-10-21T09:00:00.000Z' };
  assert.deepEqual(planProblems(fixture('C'), 'C', glass), []);
  for (const [name, edit, pattern] of [
    ['production', (p, r) => { p.variables.environment.value = 'production'; r.environment = 'production'; }, /break-glass is never allowed for production/],
    ['production profile', (p) => { p.variables.deployment_profile.value = 'production'; }, /break-glass is never allowed for production/],
    ['no reason', (_p, r) => { delete r.reason; }, /reason/],
    ['empty reason', (_p, r) => { r.reason = '   '; }, /reason/],
  ]) {
    const plan = fixture('C'); const record = structuredClone(glass); edit(plan, record);
    const problems = planProblems(plan, 'C', record);
    assert.ok(problems.some((reason) => pattern.test(reason)), `${name}: ${problems.join('; ')}`);
  }
});

test('the plan checker CLI is read-only, fails closed, and does not echo invalid JSON contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-plan-'));
  try {
    const file = join(dir, 'c.json'); const text = JSON.stringify(fixture('C')); writeFileSync(file, text);
    const script = new URL('./check-plan.mjs', import.meta.url).pathname;
    const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: {} });
    // Stage C reads the record verify-image.mjs wrote next to the saved plan.
    const missing = run(['C', file]); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /verified-image\.json/);
    const recordFile = join(dir, 'verified-image.json'); const recordText = JSON.stringify(RECORD); writeFileSync(recordFile, recordText);
    const ok = run(['C', file]); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /line-by-line resource and cost review is still required/);
    assert.match(ok.stdout, /signature verified/);
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.equal(readFileSync(recordFile, 'utf8'), recordText);
    writeFileSync(recordFile, JSON.stringify({ ...RECORD, method: 'break-glass', reason: 'CI down since 09:00, synthetic hotfix' }));
    const glass = run(['C', file]); assert.equal(glass.status, 0, glass.stderr); assert.match(glass.stderr, /BREAK-GLASS: UNSIGNED IMAGE.*CI down since 09:00/);
    writeFileSync(recordFile, 'SYNTHETIC_RECORD_CANARY'); const badRecord = run(['C', file]); assert.notEqual(badRecord.status, 0);
    assert.doesNotMatch(badRecord.stdout + badRecord.stderr, /SYNTHETIC_RECORD_CANARY/);
    writeFileSync(recordFile, recordText);
    assert.notEqual(run(['A', file]).status, 0);
    assert.notEqual(run(['C', file, '--apply']).status, 0);
    writeFileSync(file, 'SYNTHETIC_PRIVATE_CANARY'); const bad = run(['C', file]); assert.notEqual(bad.status, 0); assert.doesNotMatch(bad.stdout + bad.stderr, /SYNTHETIC_PRIVATE_CANARY/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The SES change after stage A: address identity -> its domain, so Cognito's mail is DKIM-signed as the domain (DMARC p=reject).
// Applied in two targeted plans (Terraform marks both `complete: false`): first the identity and the notifier policy, then, once
// SES reports the domain verified, the user pool on its own. Cognito refuses an unverified identity (staging, 2026-10-30).
const IDENTITY = { address: 'aws_sesv2_email_identity.from', mode: 'managed', change: { actions: ['delete', 'create'], before: { email_identity: 'no-reply@staging.telesphoros.app' }, after: { email_identity: 'staging.telesphoros.app' }, after_unknown: { arn: true } } };
const POLICY = { address: 'aws_iam_role_policy.password_notifier', mode: 'managed', change: { actions: ['update'], before: { name: 'send-notice', policy: '{}' }, after: { name: 'send-notice' }, after_unknown: { policy: true } } };
const pool = (sourceArn) => ({ name: 'telesphoros-staging', deletion_protection: 'INACTIVE', mfa_configuration: 'ON',
  email_configuration: [{ email_sending_account: 'DEVELOPER', from_email_address: 'no-reply@staging.telesphoros.app', source_arn: sourceArn }] });
const POOL = { address: 'aws_cognito_user_pool.main', mode: 'managed', change: { actions: ['update'], before: pool(`arn:aws:ses:${REGION}:${ACCOUNT}:identity/no-reply@staging.telesphoros.app`), after: pool(`arn:aws:ses:${REGION}:${ACCOUNT}:identity/staging.telesphoros.app`), after_unknown: {} } };
function sesPlan(...changes) {
  return {
    format_version: '1.2', complete: false, applyable: true, errored: false,
    variables: { deployment_profile: { value: 'synthetic' }, environment: { value: 'staging' } },
    resource_changes: [...structuredClone(changes),
      { address: 'data.aws_iam_policy_document.password_notifier', mode: 'data', change: { actions: ['read'] } },
      { address: 'aws_s3_bucket.reports', mode: 'managed', change: { actions: ['no-op'] } }],
  };
}

test('SES: accepts the two targeted applies (identity + policy, then the pool alone), though Terraform marks them incomplete', () => {
  assert.deepEqual(planProblems(sesPlan(IDENTITY, POLICY), 'SES'), []);
  assert.deepEqual(planProblems(sesPlan(POOL), 'SES'), []);
  assert.deepEqual(planProblems(sesPlan(POLICY), 'SES'), []);
});

test('SES: refuses the identity and the pool in one plan, which Cognito rejects while the new identity is unverified', () => {
  assert.ok(planProblems(sesPlan(IDENTITY, POLICY, POOL), 'SES').some((problem) => /in one plan/.test(problem)));
});

test('SES: refuses a replaced user pool, any other pool change, a foreign domain, an empty plan, errors and anything extra', () => {
  const cases = [
    ['pool replaced', () => { const plan = sesPlan(POOL); plan.resource_changes[0].change.actions = ['delete', 'create']; return plan; }, /never replaced/],
    ['pool MFA changed', () => { const plan = sesPlan(POOL); plan.resource_changes[0].change.after.mfa_configuration = 'OFF'; return plan; }, /only the email configuration's SES source ARN/],
    ['pool sender changed', () => { const plan = sesPlan(POOL); plan.resource_changes[0].change.after.email_configuration[0].from_email_address = 'x@evil.example'; return plan; }, /only the email configuration's SES source ARN/],
    ['pool other value unknown', () => { const plan = sesPlan(POOL); plan.resource_changes[0].change.after_unknown.mfa_configuration = true; return plan; }, /only the email configuration's SES source ARN/],
    ['identity to another domain', () => { const plan = sesPlan(IDENTITY, POLICY); plan.resource_changes[0].change.after.email_identity = 'evil.example'; return plan; }, /own domain/],
    ['identity updated, not replaced', () => { const plan = sesPlan(IDENTITY, POLICY); plan.resource_changes[0].change.actions = ['update']; return plan; }, /must be replaced/],
    ['policy replaced', () => { const plan = sesPlan(POLICY); plan.resource_changes[0].change.actions = ['delete', 'create']; return plan; }, /in-place update/],
    ['empty plan', () => sesPlan(), /changes nothing/],
    ['errored plan', () => { const plan = sesPlan(POOL); plan.errored = true; return plan; }, /free of errors/],
    ['extra resource', () => { const plan = sesPlan(POOL); plan.resource_changes.push({ address: 'aws_s3_bucket.reports_copy', mode: 'managed', change: { actions: ['create'], before: null, after: {} } }); return plan; }, /unexpected change/],
    ['production', () => { const plan = sesPlan(POOL); plan.variables.deployment_profile.value = 'production'; return plan; }, /staging\/synthetic/],
  ];
  for (const [name, build, expected] of cases) {
    const problems = planProblems(build(), 'SES');
    assert.ok(problems.some((problem) => expected.test(problem)), `${name}: expected ${expected}, got ${JSON.stringify(problems)}`);
  }
});

test('stages A/B/C still require a complete plan (only SES is checked change by change)', () => {
  const plan = fixture('A');
  plan.complete = false;
  assert.ok(planProblems(plan, 'A').some((problem) => /complete/.test(problem)));
});
