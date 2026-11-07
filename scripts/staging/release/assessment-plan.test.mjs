// ASSESSMENT-ON / ASSESSMENT-OFF (spec 032 S3, PR 3c-3a): the plan shape release-check.mjs accepts for switching the synthetic assessment, on the invented
// plans of fence-plan.fixtures.mjs. Imported by infrastructure/terraform/guard.test.mjs. Like the fence's tests, every refusal is shown on a plan that
// is otherwise good, and none may print a value from the plan.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ASSESSMENT_SETTINGS } from './fence-plan.mjs';
import { FLAG_MODES } from './fence-vars.mjs';
import { problems } from './release-check.mjs';
import { ASSESSMENT_ENV, FENCE_IMAGE, assessmentPlan, fencePlan, providerReadBack } from './fence-plan.fixtures.mjs';

const td = (p) => p.resource_changes[0].change;
const svc = (p) => p.resource_changes[1].change;
const edit = (p, side, change) => { const c = JSON.parse(td(p)[side].container_definitions); change(c[0]); td(p)[side].container_definitions = JSON.stringify(c); };
const env = (c, name) => c.environment.find((e) => e.name === name);
const drop = (c, name) => { c.environment = c.environment.filter((e) => e.name !== name); };
const check = (mode, plan, image = FENCE_IMAGE) => problems(mode, plan, FENCE_IMAGE, image);

test('the mode list is the four one-flag modes, and the settings the checker expects are the ones the fixtures install', () => {
  assert.deepEqual([...FLAG_MODES].sort(), ['ASSESSMENT-OFF', 'ASSESSMENT-ON', 'FENCE-CLOSE', 'FENCE-OPEN']);
  assert.deepEqual(ASSESSMENT_ENV, Object.entries(ASSESSMENT_SETTINGS).map(([name, value]) => ({ name, value })));
});

for (const mode of ['ASSESSMENT-ON', 'ASSESSMENT-OFF']) test(`${mode} accepts only its same-image assessment settings transition`, () => {
  assert.deepEqual(check(mode, assessmentPlan(mode)), []);
});
test('the provider read-back of a real replacement is not a change for the assessment either', () => {
  for (const mode of ['ASSESSMENT-ON', 'ASSESSMENT-OFF']) assert.deepEqual(check(mode, providerReadBack(assessmentPlan(mode))), []);
});
test('Terraform may omit empty drift and output sections', () => {
  const p = assessmentPlan(); delete p.resource_drift; delete p.output_changes;
  assert.deepEqual(check('ASSESSMENT-ON', p), []);
});

// What every direction refuses, on a plan that is otherwise good.
const common = [
  ['an image change', (p) => edit(p, 'after', (c) => { c.image = c.image.replace(/a/g, 'b'); })],
  ['another environment setting', (p) => edit(p, 'after', (c) => { env(c, 'NODE_ENV').value = 'development'; })],
  ['a changed medication setting', (p) => edit(p, 'after', (c) => { env(c, 'MEDICATION_WRITES').value = 'enabled'; })],
  ['a new unrelated setting', (p) => edit(p, 'after', (c) => { c.environment.push({ name: 'DEBUG', value: '1' }); })],
  ['a secret change', (p) => edit(p, 'after', (c) => { c.secrets = [{ name: 'DATABASE_URL', valueFrom: 'SYN-PRIVATE' }]; })],
  ['a secret named for the switch', (p) => edit(p, 'before', (c) => { c.secrets = [{ name: 'SYNTHETIC_ASSESSMENT', valueFrom: 'SYN-PRIVATE' }]; })],
  ['a secret named for the directory', (p) => edit(p, 'after', (c) => { c.secrets = [{ name: 'SYNTHETIC_KNOWLEDGE_DIR', valueFrom: 'SYN-PRIVATE' }]; })],
  // The same secret on both sides leaves the rest of the definition equal, so only the explicit check on the setting names refuses it.
  ['the same secret named for the switch on both sides', (p) => { for (const side of ['before', 'after']) edit(p, side, (c) => { c.secrets = [{ name: 'SYNTHETIC_ASSESSMENT', valueFrom: 'SYN-PRIVATE' }]; }); }],
  ['the same secret named for the directory on both sides', (p) => { for (const side of ['before', 'after']) edit(p, side, (c) => { c.secrets = [{ name: 'SYNTHETIC_KNOWLEDGE_DIR', valueFrom: 'SYN-PRIVATE' }]; }); }],
  ['an environment file', (p) => edit(p, 'after', (c) => { c.environmentFiles = [{ value: 'SYN-PRIVATE' }]; })],
  ['a duplicated switch', (p) => edit(p, 'after', (c) => { c.environment.push({ name: 'SYNTHETIC_ASSESSMENT', value: 'enabled' }); })],
  ['a CPU change', (p) => { td(p).after.cpu = '1024'; }],
  ['an unknown container definition', (p) => { td(p).after_unknown.container_definitions = true; }],
  ['an unknown service setting', (p) => { svc(p).after_unknown.desired_count = true; }],
  ['no steady-state wait', (p) => { svc(p).before.wait_for_steady_state = false; svc(p).after.wait_for_steady_state = false; }],
  ['a service capacity change', (p) => { svc(p).after.desired_count = 0; }],
  ['a service pointing at another resource', (p) => { p.configuration.root_module.resources[0].expressions.task_definition.references = ['aws_ecs_task_definition.worker']; }],
  ['an unrelated resource change', (p) => { p.resource_changes.push({ address: 'aws_db_instance.main', mode: 'managed', type: 'aws_db_instance', change: { actions: ['delete', 'create'] } }); }],
  ['the worker instead of the API', (p) => { p.resource_changes[0].address = 'aws_ecs_task_definition.worker[0]'; }],
  ['a missing service update', (p) => { p.resource_changes.pop(); }],
  ['an output change', (p) => { p.output_changes.x = { actions: ['update'] }; }],
  ['drift', (p) => { p.resource_drift.push({ change: { actions: ['update'] } }); }],
  ['a partial plan', (p) => { p.complete = false; }],
  ['another environment', (p) => { p.variables.environment.value = 'production'; }],
  ['another profile', (p) => { p.variables.deployment_profile.value = 'production'; }],
  ['a different image variable', (p) => { p.variables.api_migrate_image.value = FENCE_IMAGE.replace(/a{64}$/, 'b'.repeat(64)); }],
  ['the flag planned the wrong way round', (p) => { p.variables.synthetic_assessment_enabled.value = !p.variables.synthetic_assessment_enabled.value; }],
  ['no assessment variable at all', (p) => { delete p.variables.synthetic_assessment_enabled; }],
];
for (const mode of ['ASSESSMENT-ON', 'ASSESSMENT-OFF']) for (const [name, change] of common) test(`${mode} refuses ${name}`, () => {
  const plan = assessmentPlan(mode); change(plan);
  const found = check(mode, plan);
  assert.ok(found.length > 0, `${mode} must refuse ${name}`);
  assert.ok(!JSON.stringify(found).includes('SYN-PRIVATE'), 'a refusal never prints a value from the plan');
});

// Switching on: both settings arrive together, exactly as Terraform writes them, onto a task that had neither.
for (const [name, change] of [
  ['a different directory', (p) => edit(p, 'after', (c) => { env(c, 'SYNTHETIC_KNOWLEDGE_DIR').value = '/app/knowledge'; })],
  ['the switch set to something else', (p) => edit(p, 'after', (c) => { env(c, 'SYNTHETIC_ASSESSMENT').value = 'disabled'; })],
  ['the switch without its directory', (p) => edit(p, 'after', (c) => drop(c, 'SYNTHETIC_KNOWLEDGE_DIR'))],
  ['the directory without its switch', (p) => edit(p, 'after', (c) => drop(c, 'SYNTHETIC_ASSESSMENT'))],
  ['neither setting', (p) => edit(p, 'after', (c) => { drop(c, 'SYNTHETIC_ASSESSMENT'); drop(c, 'SYNTHETIC_KNOWLEDGE_DIR'); })],
  ['a task that was already on', (p) => edit(p, 'before', (c) => c.environment.push(...ASSESSMENT_ENV))],
  ['a task that was half on', (p) => edit(p, 'before', (c) => c.environment.push(ASSESSMENT_ENV[0]))],
  ['a task that had only the directory', (p) => edit(p, 'before', (c) => c.environment.push(ASSESSMENT_ENV[1]))],
]) test(`ASSESSMENT-ON refuses ${name}`, () => {
  const plan = assessmentPlan('ASSESSMENT-ON'); change(plan);
  assert.ok(check('ASSESSMENT-ON', plan).length > 0);
});

// Switching off: both settings go together, from a task that had exactly what ON installs.
for (const [name, change] of [
  ['a task that was already off', (p) => edit(p, 'before', (c) => { drop(c, 'SYNTHETIC_ASSESSMENT'); drop(c, 'SYNTHETIC_KNOWLEDGE_DIR'); })],
  ['a task that was half on', (p) => edit(p, 'before', (c) => drop(c, 'SYNTHETIC_KNOWLEDGE_DIR'))],
  ['a task whose directory was somewhere else', (p) => edit(p, 'before', (c) => { env(c, 'SYNTHETIC_KNOWLEDGE_DIR').value = '/app/knowledge'; })],
  ['the switch left behind', (p) => edit(p, 'after', (c) => c.environment.push(ASSESSMENT_ENV[0]))],
  ['the directory left behind', (p) => edit(p, 'after', (c) => c.environment.push(ASSESSMENT_ENV[1]))],
  ['the switch turned to disabled instead of removed', (p) => edit(p, 'after', (c) => c.environment.push({ name: 'SYNTHETIC_ASSESSMENT', value: 'disabled' }))],
]) test(`ASSESSMENT-OFF refuses ${name}`, () => {
  const plan = assessmentPlan('ASSESSMENT-OFF'); change(plan);
  assert.ok(check('ASSESSMENT-OFF', plan).length > 0);
});

test('the image arguments must be one digest-pinned image, and a malformed plan is refused', () => {
  assert.ok(check('ASSESSMENT-ON', assessmentPlan(), FENCE_IMAGE.replace(/a{64}$/, 'b'.repeat(64))).length > 0);
  assert.ok(problems('ASSESSMENT-ON', assessmentPlan(), 'not-an-image', 'not-an-image').length > 0);
  for (const plan of [null, {}, { resource_changes: [] }]) assert.ok(check('ASSESSMENT-ON', plan).length > 0);
});

test('the assessment and the medication fence do not accept each other\'s plans, nor may a fence plan carry the assessment along', () => {
  for (const mode of ['FENCE-CLOSE', 'FENCE-OPEN']) assert.ok(check(mode, assessmentPlan('ASSESSMENT-ON')).length > 0, `${mode} must refuse an assessment plan`);
  for (const mode of ['ASSESSMENT-ON', 'ASSESSMENT-OFF']) for (const fence of ['FENCE-CLOSE', 'FENCE-OPEN']) {
    assert.ok(check(mode, fencePlan(fence)).length > 0, `${mode} must refuse a ${fence} plan`);
  }
  const ridesAlong = fencePlan('FENCE-CLOSE', true);
  edit(ridesAlong, 'after', (c) => c.environment.push(...ASSESSMENT_ENV));
  assert.ok(check('FENCE-CLOSE', ridesAlong).length > 0, 'a medication close that also switches the assessment on is refused');
  const quietly = fencePlan('FENCE-CLOSE', true);
  edit(quietly, 'before', (c) => c.environment.push(...ASSESSMENT_ENV)); edit(quietly, 'after', (c) => c.environment.push(...ASSESSMENT_ENV));
  assert.deepEqual(check('FENCE-CLOSE', quietly), [], 'a medication close on a task that already has the assessment on leaves it alone');
});

test('MIGRATE, IMAGE and INFRA still refuse the configuration-only assessment plan', () => {
  for (const mode of ['MIGRATE', 'IMAGE', 'INFRA']) assert.ok(check(mode, assessmentPlan()).length > 0, `${mode} must refuse it`);
});

test('the command line prints a fixed refusal for a plan it cannot read, and passes a good plan without printing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assessment-plan-'));
  try {
    const bad = join(dir, 'bad.json'); writeFileSync(bad, 'SYN_PRIVATE_PLAN_CONTENT');
    const refused = spawnSync(process.execPath, [new URL('./release-check.mjs', import.meta.url).pathname, 'ASSESSMENT-ON', bad, FENCE_IMAGE, FENCE_IMAGE], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr, 'REFUSED: plan could not be read as JSON\n');
    assert.equal(refused.stdout, '');
    const good = join(dir, 'good.json'); writeFileSync(good, JSON.stringify(assessmentPlan()));
    const passed = spawnSync(process.execPath, [new URL('./release-check.mjs', import.meta.url).pathname, 'ASSESSMENT-ON', good, FENCE_IMAGE, FENCE_IMAGE], { encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.ok(!passed.stdout.includes('synthetic-knowledge'), 'the pass line names no setting value');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
