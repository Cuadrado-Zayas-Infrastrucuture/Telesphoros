import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess } from './check-medication-fence-rollout.mjs';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const prefix = 'arn:aws:ecs:us-east-2:111122223333:';
const cluster = `${prefix}cluster/telesphoros-staging-api`;
const service = `${prefix}service/telesphoros-staging-api/telesphoros-staging-api`;
const definition = `${prefix}task-definition/telesphoros-staging-api:12`;
const image = '111122223333.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@sha256:' + 'a'.repeat(64);
const arn = (n) => `${prefix}task/telesphoros-staging-api/${String(n).padStart(32, '0')}`;
function snapshot() {
  return {
    capturedAt: '2026-11-01T12:00:00.000Z',
    expected: { accountId: '111122223333', clusterArn: cluster, serviceArn: service, taskDefinitionArn: definition, image },
    services: { failures: [], services: [{ serviceArn: service, clusterArn: cluster, serviceName: 'telesphoros-staging-api', status: 'ACTIVE',
      taskDefinition: definition, desiredCount: 2, runningCount: 2, pendingCount: 0,
      deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: definition, desiredCount: 2, runningCount: 2, pendingCount: 0 }] }] },
    runningTaskArns: { taskArns: [arn(1), arn(2)] },
    stoppedTaskArns: { taskArns: [] },
    tasks: { failures: [], tasks: [1, 2].map((n) => ({ taskArn: arn(n), clusterArn: cluster, group: 'service:telesphoros-staging-api',
      taskDefinitionArn: definition, lastStatus: 'RUNNING', desiredStatus: 'RUNNING', healthStatus: 'HEALTHY',
      containers: [{ name: 'api', image, imageDigest: 'sha256:' + 'a'.repeat(64), lastStatus: 'RUNNING', healthStatus: 'HEALTHY' }],
      overrides: { containerOverrides: [{ name: 'api' }] } })) },
    taskDefinition: { taskDefinition: { taskDefinitionArn: definition, status: 'ACTIVE',
      containerDefinitions: [{ name: 'api', image, environment: [{ name: 'MEDICATION_WRITES', value: 'disabled' }], secrets: [], environmentFiles: [] }] } },
  };
}
const api = (s) => s.taskDefinition.taskDefinition.containerDefinitions[0];
const first = (s) => s.tasks.tasks[0];

test('reports only the observed disabled configuration, counts, and no request-drain claim', () => {
  assert.deepEqual(assess(snapshot(), NOW), { status: 'observed-disabled', runningTasks: 2, reasons: [] });
});

test('fully stopped old tasks are accounted for without treating them as serving tasks', () => {
  const s = snapshot();
  s.stoppedTaskArns.taskArns.push(arn(3));
  s.tasks.tasks.push({ taskArn: arn(3), clusterArn: cluster, group: 'service:telesphoros-staging-api', taskDefinitionArn: definition.replace(':12', ':11'),
    lastStatus: 'STOPPED', desiredStatus: 'STOPPED' });
  assert.deepEqual(assess(s, NOW), { status: 'observed-disabled', runningTasks: 2, reasons: [] });
});

for (const [name, change, reason] of [
  ['missing explicit setting', (s) => { api(s).environment = []; }, 'write-setting-not-explicitly-disabled'],
  ['enabled setting', (s) => { api(s).environment[0].value = 'enabled'; }, 'write-setting-not-explicitly-disabled'],
  ['duplicate setting', (s) => { api(s).environment.push({ name: 'MEDICATION_WRITES', value: 'enabled' }); }, 'write-setting-not-explicitly-disabled'],
  ['environment file', (s) => { api(s).environmentFiles = [{ type: 's3', value: 'SYN-PRIVATE' }]; }, 'write-setting-may-be-overridden'],
  ['secret setting', (s) => { api(s).secrets = [{ name: 'MEDICATION_WRITES', valueFrom: 'SYN-PRIVATE' }]; }, 'write-setting-may-be-overridden'],
  ['runtime environment override', (s) => { first(s).overrides.containerOverrides[0].environment = [{ name: 'MEDICATION_WRITES', value: 'enabled' }]; }, 'task-write-setting-override'],
  ['runtime command override', (s) => { first(s).overrides.containerOverrides[0].command = ['env', 'MEDICATION_WRITES=enabled']; }, 'task-write-setting-override'],
  ['runtime environment file', (s) => { first(s).overrides.containerOverrides[0].environmentFiles = [{ type: 's3', value: 'SYN-PRIVATE' }]; }, 'task-write-setting-override'],
  ['old running task', (s) => { first(s).taskDefinitionArn = definition.replace(':12', ':11'); }, 'mixed-task-revisions'],
  ['unhealthy running task', (s) => { first(s).healthStatus = 'UNHEALTHY'; }, 'task-not-stable'],
  ['missing container health', (s) => { delete first(s).containers[0].healthStatus; }, 'task-image-or-health-mismatch'],
  ['different runtime digest', (s) => { first(s).containers[0].imageDigest = 'sha256:' + 'b'.repeat(64); }, 'task-image-or-health-mismatch'],
  ['mutable definition image', (s) => { api(s).image = 'synthetic:latest'; }, 'task-definition-image-mismatch'],
  ['pending service task', (s) => { s.services.services[0].pendingCount = 1; }, 'service-not-steady'],
  ['incomplete deployment', (s) => { s.services.services[0].deployments[0].rolloutState = 'IN_PROGRESS'; }, 'deployment-not-complete'],
  ['mixed deployments', (s) => { s.services.services[0].deployments.push({ status: 'ACTIVE' }); }, 'deployment-not-complete'],
  ['zero capacity', (s) => { s.services.services[0].desiredCount = 0; }, 'service-not-steady'],
  ['wrong service', (s) => { first(s).group = 'service:another-service'; }, 'task-service-mismatch'],
  ['missing describe result', (s) => { s.tasks.tasks.pop(); }, 'task-inventory-incomplete'],
  ['unlisted active task', (s) => { s.tasks.tasks.push({ ...first(s), taskArn: arn(4) }); }, 'task-inventory-incomplete'],
  ['duplicate task inventory', (s) => { s.runningTaskArns.taskArns.push(arn(1)); }, 'task-inventory-invalid'],
  ['pagination remains', (s) => { s.runningTaskArns.nextToken = 'SYN-PRIVATE'; }, 'aws-read-paginated'],
  ['describe failure', (s) => { s.tasks.failures.push({ reason: 'SYN-PRIVATE' }); }, 'aws-read-incomplete'],
  ['unknown failures field', (s) => { delete s.services.failures; }, 'aws-read-incomplete'],
  ['stale observation', (s) => { s.capturedAt = '2026-11-01T11:54:59.999Z'; }, 'observation-not-current'],
  ['future observation', (s) => { s.capturedAt = '2026-11-01T12:00:30.001Z'; }, 'observation-not-current'],
  ['wrong expected account', (s) => { s.expected.accountId = '999900001111'; }, 'invalid-snapshot'],
  ['malformed environment files', (s) => { api(s).environmentFiles = {}; }, 'write-setting-may-be-overridden'],
]) {
  test(`holds on ${name}`, () => {
    const s = snapshot(); change(s);
    const result = assess(s, NOW);
    assert.equal(result.status, 'hold');
    assert.ok(result.reasons.includes(reason), JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes('SYN-PRIVATE'));
  });
}

test('an old task still stopping is refused even when omitted by the RUNNING-desired-status listing', () => {
  const s = snapshot();
  s.stoppedTaskArns.taskArns.push(arn(3));
  s.tasks.tasks.push({ ...first(s), taskArn: arn(3), lastStatus: 'STOPPING', desiredStatus: 'STOPPED' });
  const result = assess(s, NOW);
  assert.equal(result.status, 'hold');
  assert.ok(result.reasons.includes('task-not-stable'));
});

test('unknown or malformed snapshots never pass or throw their input', () => {
  for (const s of [null, {}, [], 'SYN-PRIVATE', { expected: {} }, { ...snapshot(), tasks: null }]) {
    assert.equal(assess(s, NOW).status, 'hold');
    assert.ok(!JSON.stringify(assess(s, NOW)).includes('SYN-PRIVATE'));
  }
});

test('CLI returns sanitized aggregate JSON and correct status for good and bad observations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'medication-fence-observation-'));
  try {
    const file = join(dir, 'snapshot.json');
    const s = snapshot(); s.capturedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(s));
    const good = spawnSync(process.execPath, [new URL('./check-medication-fence-rollout.mjs', import.meta.url).pathname, file], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout), { status: 'observed-disabled', runningTasks: 2, reasons: [] });
    writeFileSync(file, 'SYN-PRIVATE-NOT-JSON');
    const bad = spawnSync(process.execPath, [new URL('./check-medication-fence-rollout.mjs', import.meta.url).pathname, file], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.deepEqual(JSON.parse(bad.stdout), { status: 'hold', runningTasks: 0, reasons: ['invalid-snapshot'] });
    assert.ok(!bad.stdout.includes('SYN-PRIVATE'));
    assert.equal(bad.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
