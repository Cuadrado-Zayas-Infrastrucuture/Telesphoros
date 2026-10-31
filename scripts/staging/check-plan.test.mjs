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

test('staged plans accept create-only A/B and exactly the five repository-only updates in first-image C', () => {
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

// RDS moves latest_restorable_time on its own every few minutes; a running database must not block every later plan.
const restoreMark = (overrides = {}) => ({ address: 'aws_db_instance.main', mode: 'managed', type: 'aws_db_instance', change: {
  actions: ['update'], before: { identifier: 'telesphoros-staging', latest_restorable_time: '2026-10-30T01:00:00Z' },
  after: { identifier: 'telesphoros-staging', latest_restorable_time: '2026-10-30T01:05:00Z' }, ...overrides } });

test('drift that only moves the database restore mark is not review drift, in every stage', () => {
  for (const stage of ['A', 'B', 'C']) {
    const plan = fixture(stage); plan.resource_drift = [restoreMark()];
    assert.deepEqual(planProblems(plan, stage, RECORD), [], stage);
  }
  const ses = sesPlan(POOL); ses.resource_drift = [restoreMark()];
  assert.deepEqual(planProblems(ses, 'SES'), []);
});

test('any other drift is still refused, including the restore mark beside another change', () => {
  const cases = [
    ['another attribute too', restoreMark({ after: { identifier: 'renamed', latest_restorable_time: '2026-10-30T01:05:00Z' } })],
    ['same attribute, another type', { ...restoreMark(), address: 'aws_rds_cluster.main', type: 'aws_rds_cluster' }],
    ['deleted outside Terraform', restoreMark({ actions: ['delete'] })],
    ['no before', restoreMark({ before: null })],
    ['nothing moved', restoreMark({ after: { identifier: 'telesphoros-staging', latest_restorable_time: '2026-10-30T01:00:00Z' } })],
    ['data source', { ...restoreMark(), mode: 'data' }],
    ['untyped entry', { change: { actions: ['update'] } }],
  ];
  for (const [name, entry] of cases) {
    for (const stage of ['A', 'B', 'C']) {
      const plan = fixture(stage); plan.resource_drift = [entry];
      assert.ok(planProblems(plan, stage, RECORD).some((reason) => reason.includes('drift')), `${name} (${stage})`);
    }
    const ses = sesPlan(POOL); ses.resource_drift = [entry];
    assert.ok(planProblems(ses, 'SES').some((reason) => reason.includes('drift')), `${name} (SES)`);
  }
  const both = fixture('B'); both.resource_drift = [restoreMark(), { address: 'aws_s3_bucket.reports', mode: 'managed', type: 'aws_s3_bucket', change: { actions: ['update'], before: { a: 1 }, after: { a: 2 } } }];
  assert.ok(planProblems(both, 'B', RECORD).some((reason) => reason.includes('drift')), 'restore mark beside real drift');
});

// WEB: the one change F1 makes to the web distribution: a cached /assets/* path. Applied as a targeted plan (Terraform marks it
// `complete: false`) or a full one; every change in the plan is checked either way. Shapes modelled on `terraform show -json`:
// computed attributes (etag, status, last_modified_time) are missing from `after` and listed in `after_unknown`.
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6'; // verified in the staging account on 2026-10-31
const ROUTING_FUNCTION = `arn:aws:cloudfront::${ACCOUNT}:function/telesphoros-staging-web-routing`;
const HEADERS_POLICY = '11111111-2222-3333-4444-555555555555';
const behaviour = (cachePolicy, path) => ({
  ...(path ? { path_pattern: path } : {}),
  target_origin_id: 'web-s3', viewer_protocol_policy: 'redirect-to-https', allowed_methods: ['GET', 'HEAD'], cached_methods: ['GET', 'HEAD'], compress: true,
  cache_policy_id: cachePolicy, response_headers_policy_id: HEADERS_POLICY, function_association: [{ event_type: 'viewer-request', function_arn: ROUTING_FUNCTION }],
  origin_request_policy_id: '', field_level_encryption_id: '', realtime_log_config_arn: '', lambda_function_association: [], trusted_key_groups: [], trusted_signers: [],
  forwarded_values: [], min_ttl: 0, default_ttl: 0, max_ttl: 0, smooth_streaming: false, grpc_config: [{ enabled: false }],
});
const ASSETS = behaviour(CACHING_OPTIMIZED, '/assets/*');
const DISTRIBUTION_ARN = `arn:aws:cloudfront::${ACCOUNT}:distribution/E1WD7E7PP8PU73`;
const distribution = (ordered, extra = {}) => ({
  arn: DISTRIBUTION_ARN, aliases: ['app.staging.telesphoros.app', 'staging.telesphoros.app'], enabled: true, default_root_object: 'index.html', price_class: 'PriceClass_100', http_version: 'http2and3',
  default_cache_behavior: [behaviour(CACHING_DISABLED)], ordered_cache_behavior: ordered, origin: [{ origin_id: 'web-s3', domain_name: 'web.s3.us-east-2.amazonaws.com' }],
  tags: { Project: 'telesphoros' }, ...extra,
});
const COMPUTED = { etag: 'E2QWRUHAPOMQZL', last_modified_time: '2026-10-30T12:00:00Z', status: 'Deployed', in_progress_validation_batches: 0 };
const DISTRIBUTION_CHANGE = () => ({
  address: 'aws_cloudfront_distribution.web[0]', mode: 'managed', type: 'aws_cloudfront_distribution',
  change: { actions: ['update'], before: { ...distribution([]), ...COMPUTED }, after: distribution([ASSETS]),
    after_unknown: { etag: true, last_modified_time: true, status: true, in_progress_validation_batches: true } },
});
function webPlan(...changes) {
  return {
    format_version: '1.2', complete: false, applyable: true, errored: false,
    variables: { deployment_profile: { value: 'synthetic' }, environment: { value: 'staging' }, enable_web_hosting: { value: true } },
    resource_changes: [...changes,
      { address: 'data.aws_iam_policy_document.web[0]', mode: 'data', change: { actions: ['read'] } },
      { address: 'aws_s3_bucket.web[0]', mode: 'managed', change: { actions: ['no-op'] } }],
  };
}

test('WEB: accepts the one update that adds the cached /assets/* path, targeted or full', () => {
  assert.deepEqual(planProblems(webPlan(DISTRIBUTION_CHANGE()), 'WEB'), []);
  const full = webPlan(DISTRIBUTION_CHANGE());
  full.complete = true;
  assert.deepEqual(planProblems(full, 'WEB'), []);
});

test('WEB: refuses anything but that one update, and every way the cached path could be wider than agreed', () => {
  const edit = (mutate) => () => { const change = DISTRIBUTION_CHANGE(); mutate(change.change); return webPlan(change); };
  const cases = [
    ['distribution replaced', edit((c) => { c.actions = ['delete', 'create']; }), /must be updated in place/],
    ['distribution created', edit((c) => { c.actions = ['create']; c.before = null; }), /must be updated in place/],
    ['empty plan', () => webPlan(), /changes nothing/],
    ['errored plan', () => { const plan = webPlan(DISTRIBUTION_CHANGE()); plan.errored = true; return plan; }, /free of errors/],
    ['not applyable', () => { const plan = webPlan(DISTRIBUTION_CHANGE()); plan.applyable = false; return plan; }, /free of errors/],
    ['production', () => { const plan = webPlan(DISTRIBUTION_CHANGE()); plan.variables.deployment_profile.value = 'production'; return plan; }, /staging\/synthetic/],
    ['web hosting off', () => { const plan = webPlan(DISTRIBUTION_CHANGE()); plan.variables.enable_web_hosting.value = false; return plan; }, /web hosting/],
    ['another resource changed', () => webPlan(DISTRIBUTION_CHANGE(), { address: 'aws_s3_bucket_versioning.web[0]', mode: 'managed', change: { actions: ['update'], before: {}, after: {} } }), /unexpected change/],
    ['a resource created', () => webPlan(DISTRIBUTION_CHANGE(), { address: 'aws_s3_bucket.copy', mode: 'managed', change: { actions: ['create'], before: null, after: {} } }), /unexpected change/],
    ['no cached path added', edit((c) => { c.after.ordered_cache_behavior = []; }), /exactly one cached path/],
    ['a cached path existed before', edit((c) => { c.before.ordered_cache_behavior = [ASSETS]; }), /no cached path before/],
    ['two cached paths', edit((c) => { c.after.ordered_cache_behavior = [ASSETS, { ...ASSETS, path_pattern: '/*.html' }]; }), /exactly one cached path/],
    ['another path', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, path_pattern: '/*' }]; }), /\/assets\/\*/],
    ['the shell cached (caching policy on the default)', edit((c) => { c.after.default_cache_behavior = [behaviour(CACHING_OPTIMIZED)]; }), /default behaviour/],
    ['a different cache policy on the path', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, cache_policy_id: CACHING_DISABLED }]; }), /CachingOptimized/],
    ['writes allowed', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, allowed_methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS', 'DELETE'] }]; }), /read-only/],
    ['no compression', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, compress: false }]; }), /compress/],
    ['plain http allowed', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, viewer_protocol_policy: 'allow-all' }]; }), /redirect-to-https/],
    ['other security headers', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, response_headers_policy_id: 'another-policy' }]; }), /same security headers/],
    ['no host-redirect function', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, function_association: [] }]; }), /same viewer-request function/],
    ['another function', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, function_association: [{ event_type: 'viewer-request', function_arn: `arn:aws:cloudfront::${ACCOUNT}:function/other` }] }]; }), /same viewer-request function/],
    ['an edge function attached', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, lambda_function_association: [{ event_type: 'origin-request', lambda_arn: 'arn:aws:lambda:us-east-1:1:function:x:1' }] }]; }), /lambda_function_association/],
    ['query strings forwarded', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, forwarded_values: [{ query_string: true }] }]; }), /forwarded_values/],
    ['another origin', edit((c) => { c.after.ordered_cache_behavior = [{ ...ASSETS, target_origin_id: 'api' }]; }), /web-s3/],
    ['an alias changed', edit((c) => { c.after.aliases = ['evil.example']; }), /only the cached path may change/],
    ['the distribution disabled', edit((c) => { c.after.enabled = false; }), /only the cached path may change/],
    ['the origin changed', edit((c) => { c.after.origin = [{ origin_id: 'web-s3', domain_name: 'evil.example' }]; }), /only the cached path may change/],
    ['a tag changed', edit((c) => { c.after.tags = { Project: 'other' }; }), /only the cached path may change/],
    ['the default behaviour changed', edit((c) => { c.after.default_cache_behavior = [{ ...behaviour(CACHING_DISABLED), compress: false }]; }), /only the cached path may change/],
    ['an unknown value elsewhere', edit((c) => { c.after_unknown.aliases = true; }), /unknown/],
    ['an unknown value inside the path', edit((c) => { c.after_unknown.ordered_cache_behavior = [{ cache_policy_id: true }]; }), /unknown/],
    ['review drift', () => { const plan = webPlan(DISTRIBUTION_CHANGE()); plan.resource_drift = [{ address: 'aws_s3_bucket.web[0]', mode: 'managed', type: 'aws_s3_bucket', change: { actions: ['update'], before: {}, after: { versioning: [] } } }]; return plan; }, /drift/],
  ];
  for (const [name, build, expected] of cases) {
    const problems = planProblems(build(), 'WEB');
    assert.ok(problems.some((problem) => expected.test(problem)), `${name}: expected ${expected}, got ${JSON.stringify(problems)}`);
  }
});

// What the first real saved plan of this change showed (2026-10-31), beyond the distribution update itself: the provider leaves the new path's
// `grpc_config` to be computed, the bucket policy is rebuilt from the distribution's ARN so it is "known after apply" though the ARN cannot change in
// an in-place update, and three task definitions read an absent `tags` map back as an empty one.
const webPolicy = (arn) => JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'AllowCloudFrontRead', Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' },
  Action: 's3:GetObject', Resource: 'arn:aws:s3:::web/*', Condition: { StringEquals: { 'AWS:SourceArn': arn } } }] });
const BUCKET_POLICY = (mutate = () => {}) => {
  const entry = { address: 'aws_s3_bucket_policy.web[0]', mode: 'managed', type: 'aws_s3_bucket_policy',
    change: { actions: ['update'], before: { bucket: 'web', id: 'web', policy: webPolicy(DISTRIBUTION_ARN) }, after: { bucket: 'web', id: 'web' }, after_unknown: { policy: true } } };
  mutate(entry.change);
  return entry;
};
const REAL_DISTRIBUTION = (mutate = () => {}) => {
  const entry = DISTRIBUTION_CHANGE();
  delete entry.change.after.ordered_cache_behavior[0].grpc_config;
  entry.change.after_unknown.ordered_cache_behavior = [{ grpc_config: true }];
  mutate(entry.change);
  return entry;
};
const taskDefinitionTags = (name, before, after, type = 'aws_ecs_task_definition') => ({ address: `${type}.${name}[0]`, mode: 'managed', type, change: { actions: ['update'], before: { tags: before }, after: { tags: after } } });
const realPlan = (mutate = () => {}) => {
  const plan = webPlan(REAL_DISTRIBUTION(), BUCKET_POLICY());
  plan.resource_drift = [restoreMark(), taskDefinitionTags('api', null, {}), taskDefinitionTags('api_provision', null, {}), taskDefinitionTags('worker', null, {})];
  mutate(plan);
  return plan;
};

test('WEB: accepts the read-back shapes of a real plan: grpc_config to be computed, the bucket policy as unknown, empty tags read back as drift', () => {
  assert.deepEqual(planProblems(realPlan(), 'WEB'), []);
  assert.deepEqual(planProblems(realPlan((plan) => { plan.complete = true; }), 'WEB'), []);
});

test('WEB: each read-back shape is accepted only as exactly that, and anything wider is refused', () => {
  const policy = (mutate) => () => realPlan((plan) => { plan.resource_changes[1] = BUCKET_POLICY(mutate); });
  const dist = (mutate) => () => realPlan((plan) => { plan.resource_changes[0] = REAL_DISTRIBUTION(mutate); });
  const drift = (...entries) => () => realPlan((plan) => { plan.resource_drift = entries; });
  const cases = [
    // grpc_config
    ['another value unknown beside grpc_config', dist((c) => { c.after_unknown.ordered_cache_behavior = [{ grpc_config: true, forwarded_values: true }]; }), /unknown/],
    ['grpc_config unknown on the default behaviour', dist((c) => { c.after_unknown.default_cache_behavior = [{ grpc_config: true }]; }), /unknown/],
    ['grpc_config unknown on two paths', dist((c) => { c.after_unknown.ordered_cache_behavior = [{ grpc_config: true }, { grpc_config: true }]; }), /unknown/],
    // the bucket policy
    ['policy text changed in a way the plan knows', policy((c) => { c.after.policy = webPolicy('arn:aws:cloudfront::1:distribution/EEVIL'); c.after_unknown = {}; }), /bucket policy/],
    ['policy unknown and another attribute changed', policy((c) => { c.after.bucket = 'other'; }), /bucket policy/],
    ['policy unknown and a second attribute unknown', policy((c) => { c.after_unknown = { policy: true, bucket: true }; }), /bucket policy/],
    ['policy that does not name this distribution', policy((c) => { c.before.policy = webPolicy('arn:aws:cloudfront::1:distribution/EOTHER'); }), /bucket policy/],
    ['policy not JSON', policy((c) => { c.before.policy = 'not json'; }), /bucket policy/],
    ['policy replaced', policy((c) => { c.actions = ['delete', 'create']; }), /bucket policy/],
    ['policy created', policy((c) => { c.actions = ['create']; c.before = null; }), /bucket policy/],
    ['another bucket policy', () => realPlan((plan) => { const other = BUCKET_POLICY(); other.address = 'aws_s3_bucket_policy.reports[0]'; plan.resource_changes[1] = other; }), /unexpected change/],
    ['policy beside no distribution update', () => realPlan((plan) => { plan.resource_changes.splice(0, 1); }), /beside the in-place update/],
    ['the distribution ARN moves', dist((c) => { c.after.arn = 'arn:aws:cloudfront::1:distribution/ENEW'; }), /bucket policy|only the cached path may change/],
    // the drift
    ['tags gain a value', drift(taskDefinitionTags('api', null, { owner: 'x' })), /drift/],
    ['tags emptied', drift(taskDefinitionTags('api', { a: 'b' }, {})), /drift/],
    ['tags removed', drift(taskDefinitionTags('api', {}, null)), /drift/],
    ['tags read back on another type', drift(taskDefinitionTags('web', null, {}, 'aws_ecs_service')), /drift/],
    ['tags and another attribute', drift({ ...taskDefinitionTags('api', null, {}), change: { actions: ['update'], before: { tags: null, cpu: '256' }, after: { tags: {}, cpu: '512' } } }), /drift/],
    ['a task definition deleted outside Terraform', drift({ ...taskDefinitionTags('api', null, {}), change: { actions: ['delete'], before: { tags: null }, after: null } }), /drift/],
    ['a data source', drift({ ...taskDefinitionTags('api', null, {}), mode: 'data' }), /drift/],
  ];
  for (const [name, build, expected] of cases) {
    const problems = planProblems(build(), 'WEB');
    assert.ok(problems.some((problem) => expected.test(problem)), `${name}: expected ${expected}, got ${JSON.stringify(problems)}`);
  }
});

test('WEB: the empty-tags drift is a WEB allowance only: stages A, B, C and SES still refuse it', () => {
  const entry = taskDefinitionTags('api', null, {});
  for (const stage of ['A', 'B', 'C']) {
    const plan = fixture(stage); plan.resource_drift = [entry];
    assert.ok(planProblems(plan, stage, RECORD).some((reason) => reason.includes('drift')), stage);
  }
  const ses = sesPlan(POOL); ses.resource_drift = [entry];
  assert.ok(planProblems(ses, 'SES').some((reason) => reason.includes('drift')), 'SES');
});

test('WEB: the other stages still refuse a plan that only updates the distribution, and the CLI knows the stage', () => {
  for (const stage of ['A', 'B', 'C', 'SES']) assert.ok(planProblems(webPlan(DISTRIBUTION_CHANGE()), stage).length > 0, stage);
  assert.match(planProblems(webPlan(DISTRIBUTION_CHANGE()), 'X')[0], /WEB/);
  const dir = mkdtempSync(join(tmpdir(), 'staging-plan-'));
  try {
    const file = join(dir, 'web.json');
    writeFileSync(file, JSON.stringify(webPlan(DISTRIBUTION_CHANGE())));
    const run = spawnSync(process.execPath, [new URL('./check-plan.mjs', import.meta.url).pathname, 'WEB', file], { encoding: 'utf8', env: {} });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Stage WEB action checks passed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
