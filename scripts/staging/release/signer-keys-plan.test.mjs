// SIGNER-KEYS-ON / SIGNER-KEYS-OFF (spec 033-23 H1): the plan shape release-check.mjs accepts for giving the API task the knowledge signers' public
// keys (knowledge_signer_keys_on_api, knowledge-signing.tf), on the invented plans of fence-plan.fixtures.mjs. Imported by
// infrastructure/terraform/guard.test.mjs. No other release mode can do this: INFRA never changes a task definition, IMAGE never creates a key, and
// MIGRATE refuses a plan that also replaces the API task. Every refusal is shown on a plan that is otherwise good, and none may print a value.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SIGNER_KEYS_SETTING } from './fence-plan.mjs';
import { FLAG_MODES, fenceVars } from './fence-vars.mjs';
import { problems } from './release-check.mjs';
import { FENCE_IMAGE, SIGNERS, assessmentPlan, fencePlan, providerReadBack, signerKeysPlan, signerKeysValue, signerPem } from './fence-plan.fixtures.mjs';

const ON = 'SIGNER-KEYS-ON';
const OFF = 'SIGNER-KEYS-OFF';
const td = (p) => p.resource_changes[0].change;
const svc = (p) => p.resource_changes[1].change;
const edit = (p, side, change) => { const c = JSON.parse(td(p)[side].container_definitions); change(c[0]); td(p)[side].container_definitions = JSON.stringify(c); };
const keys = (c) => c.environment.find((e) => e.name === 'KNOWLEDGE_SIGNER_KEYS');
const drop = (c) => { c.environment = c.environment.filter((e) => e.name !== 'KNOWLEDGE_SIGNER_KEYS'); };
const setKeys = (value) => (c) => { drop(c); c.environment.push({ name: 'KNOWLEDGE_SIGNER_KEYS', value }); };
const check = (mode, plan, image = FENCE_IMAGE) => problems(mode, plan, FENCE_IMAGE, image);
// What no refusal may print: the invented key material and a planted private value.
const SECRET_MARKS = ['MFkwEwYH', 'SYN-PRIVATE'];
const silent = (found) => SECRET_MARKS.every((mark) => !JSON.stringify(found).includes(mark));

test('the mode list is the six one-flag modes, and the setting the checker names is the one Terraform writes', () => {
  assert.deepEqual([...FLAG_MODES].sort(), ['ASSESSMENT-OFF', 'ASSESSMENT-ON', 'FENCE-CLOSE', 'FENCE-OPEN', 'SIGNER-KEYS-OFF', 'SIGNER-KEYS-ON']);
  assert.equal(SIGNER_KEYS_SETTING, 'KNOWLEDGE_SIGNER_KEYS');
});

test('the signer-keys modes set only knowledge_signer_keys_on_api and keep every other byte of the var file', () => {
  const source = 'api_image = "SYN-PRIVATE-IMAGE"\nknowledge_signers = { jan = "SYN-PRIVATE-ARN" }\n';
  assert.equal(fenceVars(source, ON), source + 'knowledge_signer_keys_on_api = true\n');
  assert.equal(fenceVars(source, OFF), source + 'knowledge_signer_keys_on_api = false\n');
  assert.equal(fenceVars(source + 'knowledge_signer_keys_on_api = false\n', ON), source + 'knowledge_signer_keys_on_api = true\n');
  assert.equal(fenceVars(source + 'knowledge_signer_keys_on_api = true # approved\n', OFF), source + 'knowledge_signer_keys_on_api = false\n');
  const others = source + 'synthetic_assessment_enabled = true\nmedication_writes_enabled = false\n';
  assert.equal(fenceVars(others, ON), others + 'knowledge_signer_keys_on_api = true\n', 'the other flags are left alone');
  assert.equal(fenceVars(others + 'knowledge_signer_keys_on_api = true\n', 'ASSESSMENT-OFF'),
    source + 'synthetic_assessment_enabled = false\nmedication_writes_enabled = false\nknowledge_signer_keys_on_api = true\n', 'and they leave this one alone');
  for (const text of ['knowledge_signer_keys_on_api = 1', 'knowledge_signer_keys_on_api = "true"', 'knowledge_signer_keys_on_api = var.x',
    'knowledge_signer_keys_on_api = false\nknowledge_signer_keys_on_api = true']) assert.throws(() => fenceVars(text, ON));
});

for (const mode of [ON, OFF]) test(`${mode} accepts only its same-image signer-keys transition`, () => {
  assert.deepEqual(check(mode, signerKeysPlan(mode)), []);
});
test('the provider read-back of a real replacement is not a change for the signer keys either', () => {
  for (const mode of [ON, OFF]) assert.deepEqual(check(mode, providerReadBack(signerKeysPlan(mode))), []);
});
test('Terraform may omit empty drift and output sections', () => {
  const p = signerKeysPlan(); delete p.resource_drift; delete p.output_changes;
  assert.deepEqual(check(ON, p), []);
});

// What both directions refuse, on a plan that is otherwise good.
const common = [
  ['an image change', (p) => edit(p, 'after', (c) => { c.image = c.image.replace(/a/g, 'b'); })],
  ['another environment setting', (p) => edit(p, 'after', (c) => { c.environment.find((e) => e.name === 'NODE_ENV').value = 'development'; })],
  ['a changed medication setting', (p) => edit(p, 'after', (c) => { c.environment.find((e) => e.name === 'MEDICATION_WRITES').value = 'enabled'; })],
  ['the assessment switched on along with it', (p) => edit(p, 'after', (c) => { c.environment.push({ name: 'SYNTHETIC_ASSESSMENT', value: 'enabled' }); })],
  ['a new unrelated setting', (p) => edit(p, 'after', (c) => { c.environment.push({ name: 'DEBUG', value: '1' }); })],
  ['a secret change', (p) => edit(p, 'after', (c) => { c.secrets = [{ name: 'DATABASE_URL', valueFrom: 'SYN-PRIVATE' }]; })],
  ['the same secret named for the keys on both sides', (p) => { for (const side of ['before', 'after']) edit(p, side, (c) => { c.secrets = [{ name: 'KNOWLEDGE_SIGNER_KEYS', valueFrom: 'SYN-PRIVATE' }]; }); }],
  ['an environment file', (p) => edit(p, 'after', (c) => { c.environmentFiles = [{ value: 'SYN-PRIVATE' }]; })],
  ['a duplicated keys setting', (p) => edit(p, 'after', (c) => { c.environment.push({ name: 'KNOWLEDGE_SIGNER_KEYS', value: signerKeysValue() }); })],
  ['a CPU change', (p) => { td(p).after.cpu = '1024'; }],
  ['an unknown container definition', (p) => { td(p).after_unknown.container_definitions = true; }],
  ['an unknown service setting', (p) => { svc(p).after_unknown.desired_count = true; }],
  ['no steady-state wait', (p) => { svc(p).before.wait_for_steady_state = false; svc(p).after.wait_for_steady_state = false; }],
  ['a service capacity change', (p) => { svc(p).after.desired_count = 0; }],
  ['an unrelated resource change', (p) => { p.resource_changes.push({ address: 'aws_kms_key.knowledge_signer["jan"]', mode: 'managed', type: 'aws_kms_key', change: { actions: ['delete', 'create'] } }); }],
  ['a new key created in the same plan', (p) => { p.resource_changes.push({ address: 'aws_kms_key.knowledge_signer["new"]', mode: 'managed', type: 'aws_kms_key', change: { actions: ['create'], before: null, after: {} } }); }],
  ['the worker instead of the API', (p) => { p.resource_changes[0].address = 'aws_ecs_task_definition.worker[0]'; }],
  ['a missing service update', (p) => { p.resource_changes.pop(); }],
  ['an output change', (p) => { p.output_changes.knowledge_signer_key_arns = { actions: ['update'] }; }],
  ['drift', (p) => { p.resource_drift.push({ change: { actions: ['update'] } }); }],
  ['a partial plan', (p) => { p.complete = false; }],
  ['another environment', (p) => { p.variables.environment.value = 'production'; }],
  ['a different image variable', (p) => { p.variables.api_migrate_image.value = FENCE_IMAGE.replace(/a{64}$/, 'b'.repeat(64)); }],
  ['the flag planned the wrong way round', (p) => { p.variables.knowledge_signer_keys_on_api.value = !p.variables.knowledge_signer_keys_on_api.value; }],
  ['no switch variable at all', (p) => { delete p.variables.knowledge_signer_keys_on_api; }],
];
for (const mode of [ON, OFF]) for (const [name, change] of common) test(`${mode} refuses ${name}`, () => {
  const plan = signerKeysPlan(mode); change(plan);
  const found = check(mode, plan);
  assert.ok(found.length > 0, `${mode} must refuse ${name}`);
  assert.ok(silent(found), 'a refusal never prints a value from the plan');
});

// Switching on: onto a task that had no keys, exactly one public key per signer the plan names, and nothing that is not a public key.
const pem = signerPem('Z');
for (const [name, change] of [
  ['a task that already had keys', (p) => edit(p, 'before', setKeys(signerKeysValue()))],
  ['no keys after all', (p) => edit(p, 'after', drop)],
  ['an empty value', (p) => edit(p, 'after', setKeys(''))],
  ['a value that is not JSON', (p) => edit(p, 'after', setKeys('SYN-PRIVATE not json'))],
  ['a JSON list instead of a map', (p) => edit(p, 'after', setKeys(JSON.stringify([pem, pem])))],
  ['an empty map', (p) => edit(p, 'after', setKeys('{}'))],
  ['one signer missing', (p) => edit(p, 'after', setKeys(signerKeysValue(['jan'])))],
  ['a signer the plan does not name', (p) => edit(p, 'after', setKeys(signerKeysValue(['jan', 'kevin', 'mallory'])))],
  ['other signers than the plan names', (p) => edit(p, 'after', setKeys(signerKeysValue(['jan', 'mallory'])))],
  ['a private key instead of a public one', (p) => edit(p, 'after', setKeys(JSON.stringify({ jan: pem.replaceAll('PUBLIC', 'PRIVATE'), kevin: pem })))],
  ['a value that is not a key', (p) => edit(p, 'after', setKeys(JSON.stringify({ jan: 'SYN-PRIVATE', kevin: pem })))],
  ['a number instead of a key', (p) => edit(p, 'after', setKeys(JSON.stringify({ jan: 7, kevin: pem })))],
  ['a key with text after it', (p) => edit(p, 'after', setKeys(JSON.stringify({ jan: `${pem}SYN-PRIVATE\n`, kevin: pem })))],
  ['the same key for two signers', (p) => edit(p, 'after', setKeys(JSON.stringify({ jan: pem, kevin: pem })))],
  ['no knowledge_signers variable', (p) => { delete p.variables.knowledge_signers; }],
  ['knowledge_signers that is not a map', (p) => { p.variables.knowledge_signers.value = ['jan', 'kevin']; }],
  ['a single signer (the rule is two)', (p) => { p.variables.knowledge_signers.value = { jan: SIGNERS.jan }; edit(p, 'after', setKeys(signerKeysValue(['jan']))); }],
]) test(`${ON} refuses ${name}`, () => {
  const plan = signerKeysPlan(ON); change(plan);
  const found = check(ON, plan);
  assert.ok(found.length > 0, `${ON} must refuse ${name}`);
  assert.ok(silent(found), 'a refusal never prints a value from the plan');
});

// Switching off: from a task that had well-formed keys, to a task without the setting. It is the way back, so the signers named today need not match.
test(`${OFF} removes keys even when the signers named now differ from the ones the task carries`, () => {
  const plan = signerKeysPlan(OFF);
  plan.variables.knowledge_signers.value = { jan: SIGNERS.jan, other: 'arn:aws:iam::111122223333:role/example-other' };
  assert.deepEqual(check(OFF, plan), []);
});
for (const [name, change] of [
  ['a task that was already off', (p) => edit(p, 'before', drop)],
  ['a task whose keys were not well formed', (p) => edit(p, 'before', setKeys('SYN-PRIVATE not json'))],
  ['the keys left behind', (p) => edit(p, 'after', setKeys(signerKeysValue()))],
  ['the keys emptied instead of removed', (p) => edit(p, 'after', setKeys(''))],
  ['the keys replaced by others', (p) => edit(p, 'after', setKeys(signerKeysValue(['jan', 'mallory'])))],
]) test(`${OFF} refuses ${name}`, () => {
  const plan = signerKeysPlan(OFF); change(plan);
  const found = check(OFF, plan);
  assert.ok(found.length > 0, `${OFF} must refuse ${name}`);
  assert.ok(silent(found), 'a refusal never prints a value from the plan');
});

test('the image arguments must be one digest-pinned image, and a malformed plan is refused', () => {
  assert.ok(check(ON, signerKeysPlan(), FENCE_IMAGE.replace(/a{64}$/, 'b'.repeat(64))).length > 0);
  assert.ok(problems(ON, signerKeysPlan(), 'not-an-image', 'not-an-image').length > 0);
  for (const plan of [null, {}, { resource_changes: [] }]) assert.ok(check(ON, plan).length > 0);
});

test('the signer keys, the assessment and the medication fence do not accept each other\'s plans', () => {
  for (const mode of ['FENCE-CLOSE', 'FENCE-OPEN', 'ASSESSMENT-ON', 'ASSESSMENT-OFF']) {
    for (const keyMode of [ON, OFF]) assert.ok(check(mode, signerKeysPlan(keyMode)).length > 0, `${mode} must refuse a ${keyMode} plan`);
  }
  for (const mode of [ON, OFF]) {
    for (const other of ['ASSESSMENT-ON', 'ASSESSMENT-OFF']) assert.ok(check(mode, assessmentPlan(other)).length > 0, `${mode} must refuse an ${other} plan`);
    for (const other of ['FENCE-CLOSE', 'FENCE-OPEN']) assert.ok(check(mode, fencePlan(other)).length > 0, `${mode} must refuse a ${other} plan`);
  }
});
test('a fence or assessment plan may not carry the keys along, and leaves keys already on the task alone', () => {
  const ridesAlong = assessmentPlan('ASSESSMENT-ON');
  edit(ridesAlong, 'after', (c) => c.environment.push({ name: 'KNOWLEDGE_SIGNER_KEYS', value: signerKeysValue() }));
  assert.ok(check('ASSESSMENT-ON', ridesAlong).length > 0, 'switching the assessment on may not also give the API signer keys');
  const fenceAlong = fencePlan('FENCE-CLOSE', true);
  edit(fenceAlong, 'after', (c) => c.environment.push({ name: 'KNOWLEDGE_SIGNER_KEYS', value: signerKeysValue() }));
  assert.ok(check('FENCE-CLOSE', fenceAlong).length > 0, 'a medication close may not also give the API signer keys');
  const quietly = assessmentPlan('ASSESSMENT-ON');
  for (const side of ['before', 'after']) edit(quietly, side, (c) => c.environment.push({ name: 'KNOWLEDGE_SIGNER_KEYS', value: signerKeysValue() }));
  assert.deepEqual(check('ASSESSMENT-ON', quietly), [], 'switching the assessment on a task that already has the keys leaves them alone');
});

test('MIGRATE, IMAGE and INFRA still refuse the configuration-only signer-keys plan', () => {
  for (const mode of ['MIGRATE', 'IMAGE', 'INFRA']) for (const keyMode of [ON, OFF]) assert.ok(check(mode, signerKeysPlan(keyMode)).length > 0, `${mode} must refuse it`);
});

test('the command line passes a good plan without printing it, and refuses a bad one without printing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signer-keys-plan-'));
  const script = new URL('./release-check.mjs', import.meta.url).pathname;
  try {
    const good = join(dir, 'good.json'); writeFileSync(good, JSON.stringify(signerKeysPlan()));
    const passed = spawnSync(process.execPath, [script, ON, good, FENCE_IMAGE, FENCE_IMAGE], { encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.ok(SECRET_MARKS.every((mark) => !passed.stdout.includes(mark)), 'the pass line prints no key');
    const badPlan = signerKeysPlan(); edit(badPlan, 'after', setKeys(signerKeysValue(['jan'])));
    const bad = join(dir, 'bad.json'); writeFileSync(bad, JSON.stringify(badPlan));
    const refused = spawnSync(process.execPath, [script, ON, bad, FENCE_IMAGE, FENCE_IMAGE], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /REFUSED: signer keys/);
    assert.ok(SECRET_MARKS.every((mark) => !refused.stderr.includes(mark) && !refused.stdout.includes(mark)), 'a refusal prints no key');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
