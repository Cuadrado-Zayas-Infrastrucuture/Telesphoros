// Tests for scripts/staging/release/release-check.mjs (spec 027, PR 3a). Imported by infrastructure/terraform/guard.test.mjs (`pnpm test:infra`).
// Synthetic plans only: the shapes are what a release onto running staging may change, and nothing else. What this cannot prove: that a real
// plan of a real release has exactly these shapes (the first real release through the recipe is that check, SC-003).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problems, PROTECTED_TYPES } from './release-check.mjs';

const R = '111122223333.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@sha256:';
const OLD = R + 'a'.repeat(64);
const NEW = R + 'b'.repeat(64);
const td = (name, image) => ({ address: `aws_ecs_task_definition.${name}[0]`, mode: 'managed', type: 'aws_ecs_task_definition',
  change: { actions: ['delete', 'create'], before: { container_definitions: JSON.stringify([{ image: OLD }]) }, after: { container_definitions: JSON.stringify([{ image }]) } } });
const svc = (name) => ({ address: `aws_ecs_service.${name}[0]`, mode: 'managed', type: 'aws_ecs_service',
  change: { actions: ['update'], before: { task_definition: 'arn:old', desired_count: 1 }, after: { desired_count: 1 }, after_unknown: { task_definition: true } } });
const noop = { address: 'aws_ecs_cluster.api[0]', mode: 'managed', type: 'aws_ecs_cluster', change: { actions: ['no-op'] } };
const base = (vars, changes) => ({ format_version: '1.2', complete: true, applyable: true, errored: false, resource_drift: [], output_changes: {},
  variables: { deployment_profile: { value: 'synthetic' }, environment: { value: 'staging' }, region: { value: 'us-east-2' },
    ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { value: v }])) },
  resource_changes: [noop, ...changes] });
const migrate = () => base({ api_image: OLD, api_migrate_image: NEW }, [td('api_migrate', NEW)]);
const image = () => base({ api_image: NEW, api_migrate_image: NEW }, [td('api', NEW), td('api_provision', NEW), td('worker', NEW), svc('api'), svc('worker')]);
const alarm = (address, actions) => ({ address, mode: 'managed', type: 'aws_cloudwatch_metric_alarm', change: { actions, before: actions[0] === 'create' ? null : {}, after: actions[0] === 'delete' ? null : {} } });
const infra = () => base({ api_image: OLD, api_migrate_image: OLD }, [alarm('aws_cloudwatch_metric_alarm.sweep_failing[0]', ['create'])]);
const find = (p, a) => p.resource_changes.find((c) => c.address === a);
const drift = (address, type, before, after) => [{ address, mode: 'managed', type, change: { actions: ['update'], before, after } }];

const cases = [
  ['MIGRATE good', 'MIGRATE', migrate, true],
  ['MIGRATE with create-before-destroy order', 'MIGRATE', () => { const p = migrate(); find(p, 'aws_ecs_task_definition.api_migrate[0]').change.actions = ['create', 'delete']; return p; }, true],
  ['IMAGE good', 'IMAGE', image, true],
  ['INFRA good: merged Terraform alone, images unchanged', 'INFRA', infra, true],
  ['INFRA may delete what is not protected (#210 deleted six inert alarms)', 'INFRA', () => { const p = infra(); p.resource_changes.push(alarm('aws_cloudwatch_metric_alarm.issuer_unavailable[0]', ['delete'])); return p; }, true],
  ['MIGRATE plan given as IMAGE', 'IMAGE', migrate, false],
  ['IMAGE plan given as MIGRATE', 'MIGRATE', image, false],
  ['MIGRATE carries merged Terraform (the #210 shape): refused, plan INFRA first', 'MIGRATE', () => { const p = migrate(); p.resource_changes.push(alarm('aws_cloudwatch_metric_alarm.issuer_unavailable[0]', ['delete'])); return p; }, false],
  ['IMAGE carries merged Terraform (the #195 shape): refused', 'IMAGE', () => { const p = image(); p.resource_changes.push(alarm('aws_cloudwatch_metric_alarm.api_ledger_check_stale[0]', ['create'])); return p; }, false],
  ['MIGRATE: API task already on NEW', 'MIGRATE', () => { const p = migrate(); p.resource_changes.push(td('api', NEW)); return p; }, false],
  ['MIGRATE: migration task still on OLD', 'MIGRATE', () => { const p = migrate(); find(p, 'aws_ecs_task_definition.api_migrate[0]').change.after.container_definitions = JSON.stringify([{ image: OLD }]); return p; }, false],
  ['MIGRATE: api_image variable already NEW', 'MIGRATE', () => { const p = migrate(); p.variables.api_image.value = NEW; return p; }, false],
  ['IMAGE: worker still on OLD', 'IMAGE', () => { const p = image(); find(p, 'aws_ecs_task_definition.worker[0]').change.after.container_definitions = JSON.stringify([{ image: OLD }]); return p; }, false],
  ['IMAGE: worker task missing', 'IMAGE', () => { const p = image(); p.resource_changes = p.resource_changes.filter((c) => !c.address.startsWith('aws_ecs_task_definition.worker')); return p; }, false],
  ['IMAGE: service desired_count changes too', 'IMAGE', () => { const p = image(); find(p, 'aws_ecs_service.api[0]').change.after.desired_count = 3; return p; }, false],
  ['IMAGE: service replaced', 'IMAGE', () => { const p = image(); find(p, 'aws_ecs_service.api[0]').change.actions = ['delete', 'create']; return p; }, false],
  ['IMAGE: task defined by tag, not digest', 'IMAGE', () => { const p = image(); find(p, 'aws_ecs_task_definition.api[0]').change.after.container_definitions = JSON.stringify([{ image: R.replace('@sha256:', ':latest') }]); return p; }, false],
  ['INFRA: an image variable moved', 'INFRA', () => { const p = infra(); p.variables.api_image.value = NEW; return p; }, false],
  ['INFRA: a task definition changes', 'INFRA', () => { const p = infra(); p.resource_changes.push(td('worker', OLD)); return p; }, false],
  ['INFRA: the database is replaced', 'INFRA', () => { const p = infra(); p.resource_changes.push({ address: 'aws_db_instance.main[0]', mode: 'managed', type: 'aws_db_instance', change: { actions: ['delete', 'create'], before: {}, after: {} } }); return p; }, false],
  ['INFRA: a bucket is deleted', 'INFRA', () => { const p = infra(); p.resource_changes.push({ address: 'aws_s3_bucket.reports', mode: 'managed', type: 'aws_s3_bucket', change: { actions: ['delete'], before: {}, after: null } }); return p; }, false],
  ['INFRA with nothing to do', 'INFRA', () => base({ api_image: OLD, api_migrate_image: OLD }, []), false],
  ['targeted plan', 'IMAGE', () => { const p = image(); p.complete = false; return p; }, false],
  ['another profile', 'IMAGE', () => { const p = image(); p.variables.deployment_profile.value = 'production'; return p; }, false],
  ['harmless drift: RDS restore mark', 'IMAGE', () => { const p = image(); p.resource_drift = drift('aws_db_instance.main[0]', 'aws_db_instance', { latest_restorable_time: 'a' }, { latest_restorable_time: 'b' }); return p; }, true],
  ['harmless drift: SNS subscription confirmed', 'MIGRATE', () => { const p = migrate(); p.resource_drift = drift('aws_sns_topic_subscription.audit_alarms_email', 'aws_sns_topic_subscription', { pending_confirmation: true }, { pending_confirmation: false }); return p; }, true],
  ['harmless drift: a filter reads a nested null back as empty', 'IMAGE', () => { const p = image(); p.resource_drift = drift('aws_cloudwatch_log_metric_filter.x[0]', 'aws_cloudwatch_log_metric_filter', { metric_transformation: [{ dimensions: null, value: '1' }] }, { metric_transformation: [{ dimensions: {}, value: '1' }] }); return p; }, true],
  ['real drift: a service scaled to zero', 'IMAGE', () => { const p = image(); p.resource_drift = drift('aws_ecs_service.api[0]', 'aws_ecs_service', { desired_count: 1 }, { desired_count: 0 }); return p; }, false],
  ['real drift: SNS subscription back to pending', 'MIGRATE', () => { const p = migrate(); p.resource_drift = drift('aws_sns_topic_subscription.audit_alarms_email', 'aws_sns_topic_subscription', { pending_confirmation: false }, { pending_confirmation: true }); return p; }, false],
  ['real drift: a filter value changed', 'IMAGE', () => { const p = image(); p.resource_drift = drift('aws_cloudwatch_log_metric_filter.x[0]', 'aws_cloudwatch_log_metric_filter', { metric_transformation: [{ value: '1' }] }, { metric_transformation: [{ value: '0' }] }); return p; }, false],
  ['an output changes', 'IMAGE', () => { const p = image(); p.output_changes = { api_service_name: { actions: ['update'] } }; return p; }, false],
];

for (const [name, mode, make, pass] of cases) {
  test(`release-check ${mode}: ${name} ${pass ? 'passes' : 'is refused'}`, () => {
    const found = problems(mode, make(), OLD, NEW);
    assert.equal(found.length === 0, pass, found.join('; ') || 'passed');
  });
}

test('release-check refuses an unknown mode and two equal images', () => {
  assert.deepEqual(problems('FOLD', image(), OLD, NEW), ['mode must be MIGRATE, IMAGE or INFRA']);
  assert.ok(problems('IMAGE', image(), NEW, NEW).length > 0);
  assert.ok(problems('INFRA', infra(), OLD, OLD).length === 0, 'INFRA needs only the running image, given twice');
});

test('the protected types cover the data and identity a release must never destroy', () => {
  for (const t of ['aws_db_instance', 'aws_s3_bucket', 'aws_kms_key', 'aws_cognito_user_pool']) assert.ok(PROTECTED_TYPES.includes(t), t);
});
