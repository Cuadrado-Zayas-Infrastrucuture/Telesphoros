import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { problems } from './release-check.mjs';
import { fencePlan, FENCE_IMAGE } from './fence-plan.fixtures.mjs';

for (const mode of ['FENCE-CLOSE', 'FENCE-OPEN']) test(`${mode} accepts only its same-image medication setting transition`, () => {
  assert.deepEqual(problems(mode, fencePlan(mode), FENCE_IMAGE, FENCE_IMAGE), []);
});
test('close can install an explicit disabled value where the old task had no setting', () => {
  assert.deepEqual(problems('FENCE-CLOSE', fencePlan('FENCE-CLOSE', true), FENCE_IMAGE, FENCE_IMAGE), []);
});
for (const mode of ['MIGRATE', 'IMAGE', 'INFRA']) test(`${mode} still refuses the configuration-only transition`, () => {
  assert.ok(problems(mode, fencePlan(), FENCE_IMAGE, FENCE_IMAGE).length > 0);
});
const td = (p) => p.resource_changes[0].change;
const svc = (p) => p.resource_changes[1].change;
const editContainer = (p, edit) => { const c = JSON.parse(td(p).after.container_definitions); edit(c[0]); td(p).after.container_definitions = JSON.stringify(c); };
for (const [name, edit] of [
  ['image change', (p) => editContainer(p, (c) => { c.image = c.image.replace(/a/g, 'b'); })],
  ['another environment setting', (p) => editContainer(p, (c) => { c.environment[0].value = 'development'; })],
  ['secret change', (p) => editContainer(p, (c) => { c.secrets = [{ name: 'DATABASE_URL', valueFrom: 'SYN-PRIVATE' }]; })],
  ['duplicate flag', (p) => editContainer(p, (c) => { c.environment.push({ name: 'MEDICATION_WRITES', value: 'enabled' }); })],
  ['wrong flag direction', (p) => editContainer(p, (c) => { c.environment[1].value = 'enabled'; })],
  ['hidden flag secret', (p) => { const c = JSON.parse(td(p).before.container_definitions); c[0].secrets = [{ name: 'MEDICATION_WRITES', valueFrom: 'SYN-PRIVATE' }]; td(p).before.container_definitions = JSON.stringify(c); }],
  ['environment file', (p) => editContainer(p, (c) => { c.environmentFiles = [{ value: 'SYN-PRIVATE' }]; })],
  ['CPU change', (p) => { td(p).after.cpu = '1024'; }],
  ['unknown container definition', (p) => { td(p).after_unknown.container_definitions = true; }],
  ['unknown service setting', (p) => { svc(p).after_unknown.desired_count = true; }],
  ['no steady-state wait', (p) => { svc(p).before.wait_for_steady_state = false; svc(p).after.wait_for_steady_state = false; }],
  ['service capacity change', (p) => { svc(p).after.desired_count = 0; }],
  ['service points at another resource', (p) => { p.configuration.root_module.resources[0].expressions.task_definition.references = ['aws_ecs_task_definition.worker']; }],
  ['unrelated resource change', (p) => { p.resource_changes.push({ address: 'aws_db_instance.main', mode: 'managed', type: 'aws_db_instance', change: { actions: ['delete', 'create'] } }); }],
  ['worker instead of API', (p) => { p.resource_changes[0].address = 'aws_ecs_task_definition.worker[0]'; }],
  ['missing service update', (p) => { p.resource_changes.pop(); }],
  ['output change', (p) => { p.output_changes.x = { actions: ['update'] }; }],
  ['drift', (p) => { p.resource_drift.push({ change: { actions: ['update'] } }); }],
  ['partial plan', (p) => { p.complete = false; }],
  ['wrong target', (p) => { p.variables.environment.value = 'production'; }],
  ['wrong planned flag', (p) => { p.variables.medication_writes_enabled.value = true; }],
]) test(`fence transition refuses ${name}`, () => {
  const plan = fencePlan(); edit(plan);
  const found = problems('FENCE-CLOSE', plan, FENCE_IMAGE, FENCE_IMAGE);
  assert.ok(found.length > 0);
  assert.ok(!JSON.stringify(found).includes('SYN-PRIVATE'));
});
test('opening needs the previous explicit disabled setting', () => {
  assert.ok(problems('FENCE-OPEN', fencePlan('FENCE-OPEN', true), FENCE_IMAGE, FENCE_IMAGE).length > 0);
});
test('fence modes refuse changing image arguments and malformed plans', () => {
  assert.ok(problems('FENCE-CLOSE', fencePlan(), FENCE_IMAGE, FENCE_IMAGE.replace(/a{64}$/, 'b'.repeat(64))).length > 0);
  for (const plan of [null, {}, { resource_changes: [] }]) assert.ok(problems('FENCE-CLOSE', plan, FENCE_IMAGE, FENCE_IMAGE).length > 0);
});

test('Terraform may omit empty drift and output sections', () => {
  const p = fencePlan(); delete p.resource_drift; delete p.output_changes;
  assert.deepEqual(problems('FENCE-CLOSE', p, FENCE_IMAGE, FENCE_IMAGE), []);
});
test('already disabled is not a close transition', () => {
  const p = fencePlan(); const c = JSON.parse(td(p).before.container_definitions); c[0].environment[1].value = 'disabled'; td(p).before.container_definitions = JSON.stringify(c);
  assert.ok(problems('FENCE-CLOSE', p, FENCE_IMAGE, FENCE_IMAGE).length > 0);
});

test('malformed private plan JSON produces only a fixed refusal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fence-private-plan-'));
  try {
    const file = join(dir, 'private.json'); writeFileSync(file, 'SYN_PRIVATE_PLAN_CONTENT');
    const result = spawnSync(process.execPath, [new URL('./release-check.mjs', import.meta.url).pathname, 'FENCE-CLOSE', file, FENCE_IMAGE, FENCE_IMAGE], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'REFUSED: plan could not be read as JSON\n');
    assert.equal(result.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
