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
    variables: Object.fromEntries(Object.entries({ deployment_profile: 'synthetic', environment: 'staging', enable_api_hosting: true, enable_web_hosting: stage !== 'A', api_image: stage === 'C' ? IMAGE : '', region: REGION }).map(([name, value]) => [name, { value }])),
    resource_changes: changes,
  };
}

test('staged plans accept create-only A/B and exactly the four repository-only updates in first-image C', () => {
  for (const stage of ['A', 'B', 'C']) {
    const plan = fixture(stage);
    plan.resource_changes.push({ address: 'data.aws_caller_identity.current', mode: 'data', change: { actions: ['read'] } });
    plan.resource_changes.push({ address: 'aws_s3_bucket.reports', mode: 'managed', change: { actions: ['no-op'] } });
    assert.deepEqual(planProblems(plan, stage), []);
  }
});

test('saved -var boolean strings are accepted without treating arbitrary strings as true', () => {
  for (const stage of ['A', 'B', 'C']) {
    const plan = fixture(stage);
    plan.variables.enable_api_hosting.value = 'true';
    plan.variables.enable_web_hosting.value = stage === 'A' ? 'false' : 'true';
    assert.deepEqual(planProblems(plan, stage), []);
    for (const invalid of ['yes', 'FALSE', '', null]) {
      plan.variables.enable_web_hosting.value = invalid;
      assert.ok(planProblems(plan, stage).some((reason) => reason.includes('hosting switches')));
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
    assert.ok(planProblems(plan, 'C').length > 0, name);
  }
  for (const stage of ['A', 'B']) {
    const plan = fixture(stage); plan.resource_changes.push(fixture('C').resource_changes[1]);
    assert.ok(planProblems(plan, stage).some((reason) => reason.includes('unexpected action')), `${stage} remains create-only`);
    plan.variables.api_image.value = IMAGE;
    assert.ok(planProblems(plan, stage).some((reason) => reason.includes('must have no api_image')));
  }
  for (const plan of [null, {}, { format_version: '2.0', resource_changes: [] }]) assert.ok(planProblems(plan, 'C').length > 0);
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
    assert.ok(planProblems(plan, 'C').some((reason) => reason.includes('unexpected action')), `${address}: ${name}`);
  }
  const plan = fixture('C'); plan.resource_changes[1].change.before.policy = policy(REPOSITORY);
  assert.ok(planProblems(plan, 'C').length > 0, 'this is only the first image transition from repository/none');
  plan.resource_changes[1].change.after.policy = 'not JSON';
  assert.ok(planProblems(plan, 'C').length > 0);
});

test('the plan checker CLI is read-only, fails closed, and does not echo invalid JSON contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-plan-'));
  try {
    const file = join(dir, 'c.json'); const text = JSON.stringify(fixture('C')); writeFileSync(file, text);
    const script = new URL('./check-plan.mjs', import.meta.url).pathname;
    const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: {} });
    const ok = run(['C', file]); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /line-by-line resource and cost review is still required/);
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.notEqual(run(['A', file]).status, 0);
    assert.notEqual(run(['C', file, '--apply']).status, 0);
    writeFileSync(file, 'SYNTHETIC_PRIVATE_CANARY'); const bad = run(['C', file]); assert.notEqual(bad.status, 0); assert.doesNotMatch(bad.stdout + bad.stderr, /SYNTHETIC_PRIVATE_CANARY/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
