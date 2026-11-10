// Tests for scripts/staging/release/{claim,plan,apply,apply-run}.sh (spec 027, PR 3a). Imported by infrastructure/terraform/guard.test.mjs.
// The scripts run for real against stand-ins: an `aws` that answers the identity and the running image from files, and a `terraform` that keeps
// a state serial in a file (apply increments it), writes a distinct plan per call, and shows a plan JSON the test chooses. A real git
// repository is the backend clone. What this cannot prove: what real Terraform does with a stale saved plan (see release-rehearsal.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { assessmentPlan, fencePlan } from './fence-plan.fixtures.mjs';

const here = new URL('.', import.meta.url).pathname;
const box = mkdtempSync(join(tmpdir(), 'release-scripts-'));
after(() => rmSync(box, { recursive: true, force: true }));

const ACCOUNT = '111122223333';
const R = `${ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@sha256:`;
const OLD = R + 'a'.repeat(64);
const NEW = R + 'b'.repeat(64);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const bin = join(box, 'bin');
mkdirSync(bin);
const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
// No Terraform runs on this machine as far as these scripts can tell; the check itself is tested in scripts/staging/terraform-running.test.mjs.
stub('pgrep', 'exit 1');
stub('aws', `case "$*" in
  *"--query Account"*) echo "\${STUB_ACCOUNT:-${ACCOUNT}}" ;;
  *"--query Arn"*) echo "arn:aws:sts::${ACCOUNT}:assumed-role/StagingRole/s" ;;
  *describe-services*) echo "arn:aws:ecs:us-east-2:${ACCOUNT}:task-definition/telesphoros-staging-api:4" ;;
  *describe-task-definition*) cat "$STUB/running" ;;
  *) echo "unexpected aws $*" >&2; exit 99 ;;
esac`);
stub('terraform', `case "$*" in
  version) echo "Terraform v1.16.5" ;;
  *"state pull"*) echo "{\\"version\\":4,\\"serial\\":$(cat "$STUB/serial"),\\"lineage\\":\\"l-1\\",\\"outputs\\":{\\"x\\":{\\"value\\":\\"SENTINEL\\"}}}" ;;
  *"show -json"*) cat "$STUB/plan.json" ;;
  *"show -no-color"*) if [ -f "$STUB/show.txt" ]; then cat "$STUB/show.txt"; else echo "Plan: 0 to add, 1 to change, 0 to destroy."; fi ;;
  *" plan "*) for a in "$@"; do case "$a" in -out=*) printf 'plan %s %s\\n' "$RANDOM$RANDOM" "$*" > "\${a#-out=}" ;; esac; done ;;
  *" apply "*) echo $(( $(cat "$STUB/serial") + 1 )) > "$STUB/serial"; if [ -n "\${STUB_MUTATE_TARGET:-}" ]; then printf "SYN_UNREVIEWED_TARGET\\n" > "$STUB_MUTATE_TARGET"; fi; exit "\${STUB_APPLY_EXIT:-0}" ;;
  *) echo "unexpected terraform $*" >&2; exit 99 ;;
esac`);
const stubDir = join(box, 'stub');
mkdirSync(stubDir);
writeFileSync(join(stubDir, 'serial'), '42');
writeFileSync(join(stubDir, 'running'), `${OLD}\n`);

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const clone = join(box, 'clone');
mkdirSync(join(clone, 'infrastructure/terraform'), { recursive: true });
git(clone, 'init', '-q', '-b', 'main');
writeFileSync(join(clone, 'infrastructure/terraform/main.tf'), '');
git(clone, 'add', '.');
git(clone, 'commit', '-q', '-m', 'release');
const COMMIT = git(clone, 'rev-parse', 'HEAD');

const priv = join(box, 'private');
const staging = join(priv, 'staging');
const rel = join(priv, 'releases', COMMIT);
mkdirSync(staging, { recursive: true });
mkdirSync(rel, { recursive: true });
mkdirSync(join(priv, 'maindata'));
writeFileSync(join(staging, 'stack.env'), [`STAGING_ACCOUNT_ID=${ACCOUNT}`, `BACKEND_CLONE=${clone}`, `TERRAFORM=${join(bin, 'terraform')}`,
  `TF_DATA_DIR=${join(priv, 'maindata')}`, 'STAGING_ROLE_ARN_PART=assumed-role/StagingRole/'].join('\n'));
const current = join(staging, 'current.tfvars');
const writeCurrent = (image) => {
  writeFileSync(current, `region = "us-east-2"\napi_image = "${image}"\napi_migrate_image = "${image}"\nalarm_email = "SENTINEL-VAR@example.com"\n`);
  writeFileSync(`${current}.sha256`, `${sha(current)}\n`);
};
writeCurrent(OLD);
writeFileSync(join(rel, 'new_image.txt'), `${NEW}\n`);
writeFileSync(join(rel, 'verified-image.json'), '{}');

// Plan JSON shapes release-check.mjs accepts, one per mode.
const tdef = (name, image) => ({ address: `aws_ecs_task_definition.${name}[0]`, mode: 'managed', type: 'aws_ecs_task_definition',
  change: { actions: ['delete', 'create'], before: {}, after: { container_definitions: JSON.stringify([{ image }]) } } });
const svc = (name) => ({ address: `aws_ecs_service.${name}[0]`, mode: 'managed', type: 'aws_ecs_service',
  change: { actions: ['update'], before: { task_definition: 'a' }, after: {}, after_unknown: { task_definition: true } } });
const planJson = (vars, changes) => ({ format_version: '1.2', complete: true, applyable: true, errored: false, resource_drift: [], output_changes: {},
  variables: { deployment_profile: { value: 'synthetic' }, environment: { value: 'staging' }, region: { value: 'us-east-2' },
    ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { value: v }])) }, resource_changes: changes });
const SHAPES = {
  MIGRATE: planJson({ api_image: OLD, api_migrate_image: NEW }, [tdef('api_migrate', NEW)]),
  IMAGE: planJson({ api_image: NEW, api_migrate_image: NEW }, [tdef('api', NEW), tdef('api_provision', NEW), tdef('worker', NEW), svc('api'), svc('worker')]),
  INFRA: planJson({ api_image: OLD, api_migrate_image: OLD }, [{ address: 'aws_cloudwatch_metric_alarm.x[0]', mode: 'managed', type: 'aws_cloudwatch_metric_alarm', change: { actions: ['create'], before: null, after: {} } }]),
};

const run = (script, args, env = {}) => spawnSync('bash', [join(here, script), ...args], {
  encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: box, PRIVATE_DIR: priv, TMPDIR: box, STUB: stubDir, ...env },
});
const owner = { CLAIM_OWNER: 'session-a' };
const plan = (mode) => {
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(SHAPES[mode]));
  const r = run('plan.sh', [mode, COMMIT], owner);
  const pin = r.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1];
  return { ...r, pin };
};
const waitFor = (file) => {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(file) && /== apply exit status: \d+/.test(readFileSync(file, 'utf8'))) return readFileSync(file, 'utf8');
    spawnSync('sleep', ['0.1']);
  }
  throw new Error(`no exit line in ${file}`);
};
const quiet = (r) => { for (const s of [r.stdout, r.stderr]) assert.ok(!s.includes('SENTINEL'), s); };

test('the claim: one owner at a time, released only by its owner', () => {
  assert.equal(run('claim.sh', ['take', 'session-a', 'release 1']).status, 0);
  const second = run('claim.sh', ['take', 'session-b', 'release 2']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /the claim is held/);
  assert.equal(run('claim.sh', ['release', 'session-b']).status, 1, 'another owner cannot release it');
  assert.equal(run('claim.sh', ['release', 'session-a']).status, 0);
  assert.equal(run('claim.sh', ['take', 'session-a', 'the rest of this file']).status, 0);
});

test('plan needs the claim and the clone at the commit, and prints no state or variable value', () => {
  const none = run('plan.sh', ['MIGRATE', COMMIT]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /set CLAIM_OWNER/);
  const other = run('plan.sh', ['MIGRATE', COMMIT], { CLAIM_OWNER: 'session-b' });
  assert.match(other.stderr, /held by someone else: session-a/);
  const elsewhere = run('plan.sh', ['MIGRATE', 'f'.repeat(40)], owner);
  assert.match(elsewhere.stderr, /the clone is at .* not ffffffff/);
  const m = plan('MIGRATE');
  assert.equal(m.status, 0, m.stdout + m.stderr);
  assert.ok(m.pin);
  const meta = JSON.parse(readFileSync(join(rel, 'm.tfplan.meta.json'), 'utf8'));
  assert.deepEqual([meta.mode, meta.serial, meta.lineage, meta.head, meta.planSha256], ['MIGRATE', 42, 'l-1', COMMIT, m.pin]);
  quiet(m);
  assert.match(plan('MIGRATE').stderr, /m\.tfplan exists/, 'a second MIGRATE plan for the same release is refused');
});

test('a plan the release check refuses is not recorded, and IMAGE waits for the MIGRATE apply', () => {
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(SHAPES.IMAGE));
  const early = run('plan.sh', ['IMAGE', COMMIT], owner);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /MIGRATE apply of this release did not finish/);
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(SHAPES.MIGRATE));
  const wrongShape = run('plan.sh', ['INFRA', COMMIT], owner);
  assert.equal(wrongShape.status, 1);
  assert.match(wrongShape.stderr, /release check refused the INFRA plan/);
  assert.ok(!existsSync(join(rel, 'x.tfplan.meta.json')));
  rmSync(join(rel, 'x.tfplan'), { force: true });
});

test('an output-only plan goes out as INFRA and only as INFRA; an empty plan still stops', () => {
  const show = join(stubDir, 'show.txt');
  const planJsonFile = join(stubDir, 'plan.json');
  const forget = () => { for (const f of ['x.tfplan', 'x.tfplan.meta.json', 'x.tfplan.bundles', 'x-apply.txt']) rmSync(join(rel, f), { force: true }); };
  const outputsOnly = { ...SHAPES.INFRA, resource_changes: [], output_changes: { new_output: { actions: ['create'] } } };
  writeFileSync(show, '\nChanges to Outputs:\n  + new_output = {}\n');
  writeFileSync(planJsonFile, JSON.stringify(outputsOnly));
  const planned = run('plan.sh', ['INFRA', COMMIT], owner);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const pin = planned.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1];
  assert.ok(pin && existsSync(join(rel, 'x.tfplan.meta.json')), 'the output-only plan is recorded');
  const applied = run('apply.sh', ['INFRA', COMMIT, pin], owner);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(waitFor(join(rel, 'x-apply.txt')), /== apply exit status: 0/);
  writeFileSync(join(stubDir, 'serial'), '42');
  forget();

  writeFileSync(show, 'No changes. Your infrastructure matches the configuration.\n');
  writeFileSync(planJsonFile, JSON.stringify({ ...SHAPES.INFRA, resource_changes: [] }));
  const empty = run('plan.sh', ['INFRA', COMMIT], owner);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no Plan: line/);
  assert.ok(!existsSync(join(rel, 'x.tfplan.meta.json')));
  forget();

  renameSync(join(rel, 'm.tfplan'), join(rel, 'm.tfplan.kept'));
  writeFileSync(show, '\nChanges to Outputs:\n  + new_output = {}\n');
  writeFileSync(planJsonFile, JSON.stringify({ ...SHAPES.MIGRATE, output_changes: { new_output: { actions: ['create'] } } }));
  const notInfra = run('plan.sh', ['MIGRATE', COMMIT], owner);
  assert.equal(notInfra.status, 1);
  assert.match(notInfra.stderr, /no Plan: line/);
  rmSync(join(rel, 'm.tfplan'), { force: true });
  renameSync(join(rel, 'm.tfplan.kept'), join(rel, 'm.tfplan'));
  rmSync(show);
});

test('apply refuses a different plan, then a plan another apply made stale; the reviewed plan applies', () => {
  const m = { pin: sha(join(rel, 'm.tfplan')) };
  const x = plan('INFRA');
  assert.equal(x.status, 0, x.stdout + x.stderr);
  assert.match(run('apply.sh', ['MIGRATE', COMMIT, '0'.repeat(64)], owner).stderr, /not the plan that was read/);
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(SHAPES.MIGRATE));
  const applied = run('apply.sh', ['MIGRATE', COMMIT, m.pin], owner);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(waitFor(join(rel, 'm-apply.txt')), /== apply exit status: 0/);
  assert.equal(readFileSync(join(stubDir, 'serial'), 'utf8').trim(), '43');
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(SHAPES.INFRA));
  const stale = run('apply.sh', ['INFRA', COMMIT, x.pin], owner);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /STALE: serial: the plan was made at 42, now 43/);
  assert.ok(!existsSync(join(rel, 'x-apply.txt')), 'nothing was started');
});

test('IMAGE: after it applies, its var file becomes current.tfvars; a hand-edited current.tfvars is refused', () => {
  writeFileSync(join(rel, 'migrate-status.txt'), 'pending: (none)\n');
  const i = plan('IMAGE');
  assert.equal(i.status, 0, i.stdout + i.stderr);
  quiet(i);
  const applied = run('apply.sh', ['IMAGE', COMMIT, i.pin], owner);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const log = waitFor(join(rel, 'i-apply.txt'));
  assert.match(log, /current\.tfvars is now this release's var file/);
  assert.ok(readFileSync(current, 'utf8').split('\n').includes(`api_image = "${NEW}"`), 'current.tfvars contains the exact released api_image assignment');
  assert.equal(readFileSync(`${current}.sha256`, 'utf8').trim(), sha(current));
  for (const f of ['x.tfplan', 'x.tfplan.meta.json']) rmSync(join(rel, f), { force: true });
  const behind = run('plan.sh', ['INFRA', COMMIT], owner);
  assert.match(behind.stderr, /ECS runs sha256:a{64}, but current\.tfvars names sha256:b{64}: the var file is stale/, 'ECS has not rolled yet');
  writeFileSync(join(stubDir, 'running'), `${NEW}\n`);
  writeFileSync(current, `${readFileSync(current, 'utf8')}# edited\n`);
  rmSync(join(rel, 'x.tfplan'), { force: true });
  assert.match(run('plan.sh', ['INFRA', COMMIT], owner).stderr, /does not match its recorded sha256/);
});


test('fence operations preserve history, bind both var hashes and apply only the reviewed same-image plan', () => {
  writeCurrent(NEW); // Restore the approved baseline after the preceding hand-edit rejection control.
  const verificationFile = join(rel, 'verified-image.json');
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(fencePlan('FENCE-OPEN', false, NEW))); // Every opening-refusal control otherwise has a valid plan.
  assert.equal(run('plan.sh', ['FENCE-OPEN', COMMIT, 'unverified'], owner).status, 1, 'an empty verification marker is insufficient');
  writeFileSync(verificationFile, JSON.stringify({ format: 1, environment: 'staging', method: 'signature', images: [NEW],
    keyAlias: 'alias/telesphoros-staging-image-signing', keyArn: `arn:aws:kms:us-east-2:${ACCOUNT}:key/11111111-2222-4333-8444-555555555555`,
    cosignVersion: 'v3.1.3', recordedAt: '2026-11-01T00:00:00Z' }));
  const priorImageLog = readFileSync(join(rel, 'i-apply.txt'), 'utf8');
  writeFileSync(join(rel, 'i-apply.txt'), '== apply exit status: 9\n');
  assert.equal(run('plan.sh', ['FENCE-OPEN', COMMIT, 'incomplete-image'], owner).status, 1);
  writeFileSync(join(rel, 'i-apply.txt'), priorImageLog);
  writeFileSync(join(rel, 'migrate-status.txt'), 'pending: 0066\n');
  assert.equal(run('plan.sh', ['FENCE-OPEN', COMMIT, 'pending-migration'], owner).status, 1);
  writeFileSync(join(rel, 'migrate-status.txt'), 'pending: (none)\n');
  const original = readFileSync(current, 'utf8');
  const startSerial = readFileSync(join(stubDir, 'serial'), 'utf8');
  const saveCurrent = (text) => { writeFileSync(current, text); writeFileSync(`${current}.sha256`, sha(current) + '\n'); };
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(fencePlan('FENCE-CLOSE', true, NEW)));
  assert.equal(run('plan.sh', ['FENCE-CLOSE', COMMIT], owner).status, 1, 'an operation id is required');
  assert.equal(run('plan.sh', ['FENCE-CLOSE', COMMIT, '../escape'], owner).status, 1);
  const planned = run('plan.sh', ['FENCE-CLOSE', COMMIT, 'close-1'], owner);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr); quiet(planned);
  const folder = join(rel, 'fences/close-1');
  const pin = planned.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1];
  assert.ok(pin);
  const target = readFileSync(join(folder, 'fc.tfvars'), 'utf8');
  assert.equal(readFileSync(join(folder, 'source.tfvars'), 'utf8'), original);
  assert.equal(target, original + 'medication_writes_enabled = false\n');
  const metadata = JSON.parse(readFileSync(join(folder, 'fc.tfplan.meta.json'), 'utf8'));
  assert.equal(metadata.sourceVarSha256, sha(current));
  assert.equal(metadata.varSha256, sha(join(folder, 'fc.tfvars')));
  assert.equal(run('apply.sh', ['FENCE-CLOSE', COMMIT, '0'.repeat(64), 'close-1'], owner).status, 1);
  saveCurrent(target); // Even a changed canonical file with a valid self-hash must not pass.
  const changedSource = run('apply.sh', ['FENCE-CLOSE', COMMIT, pin, 'close-1'], owner);
  assert.equal(changedSource.status, 1); assert.match(changedSource.stderr, /sourceVarSha256|stale|source variables changed/);
  writeFileSync(join(folder, 'source.tfvars'), target);
  const changedBoth = run('apply.sh', ['FENCE-CLOSE', COMMIT, pin, 'close-1'], owner);
  assert.equal(changedBoth.status, 1); assert.match(changedBoth.stderr, /sourceVarSha256/);
  writeFileSync(join(folder, 'source.tfvars'), original);
  saveCurrent(original);
  writeFileSync(join(stubDir, 'serial'), String(Number(startSerial) + 1));
  assert.equal(run('apply.sh', ['FENCE-CLOSE', COMMIT, pin, 'close-1'], owner).status, 1, 'state drift must refuse the plan');
  writeFileSync(join(stubDir, 'serial'), startSerial);
  const started = run('apply.sh', ['FENCE-CLOSE', COMMIT, pin, 'close-1'], owner);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(waitFor(join(folder, 'fc-apply.txt')), /== apply exit status: 0/);
  assert.equal(readFileSync(current, 'utf8'), target);
  assert.equal(readFileSync(`${current}.sha256`, 'utf8').trim(), sha(current));
  assert.equal(run('plan.sh', ['FENCE-CLOSE', COMMIT, 'close-1'], owner).status, 1, 'old operation records are not overwritten');

  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(fencePlan('FENCE-OPEN', false, NEW)));
  const opening = run('plan.sh', ['FENCE-OPEN', COMMIT, 'open-1'], owner);
  assert.equal(opening.status, 0, opening.stdout + opening.stderr);
  const openPin = opening.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1];
  writeFileSync(join(rel, 'migrate-status.txt'), 'pending: 0066\n');
  assert.equal(run('apply.sh', ['FENCE-OPEN', COMMIT, openPin, 'open-1'], owner).status, 1, 'opening is rechecked at apply');
  writeFileSync(join(rel, 'migrate-status.txt'), 'pending: (none)\n');
  const openApply = run('apply.sh', ['FENCE-OPEN', COMMIT, openPin, 'open-1'], owner);
  assert.equal(openApply.status, 0, openApply.stdout + openApply.stderr);
  assert.match(waitFor(join(rel, 'fences/open-1/fo-apply.txt')), /== apply exit status: 0/);
  assert.equal(readFileSync(current, 'utf8'), original + 'medication_writes_enabled = true\n');
  assert.ok(existsSync(join(folder, 'fc.tfplan.meta.json')), 'earlier close evidence remains');

  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(fencePlan('FENCE-CLOSE', false, NEW)));
  const nextClose = run('plan.sh', ['FENCE-CLOSE', COMMIT, 'close-2'], owner);
  assert.equal(nextClose.status, 0, nextClose.stdout + nextClose.stderr);
  const nextPin = nextClose.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1];
  const nextApply = run('apply.sh', ['FENCE-CLOSE', COMMIT, nextPin, 'close-2'], owner);
  assert.equal(nextApply.status, 0, nextApply.stdout + nextApply.stderr);
  assert.match(waitFor(join(rel, 'fences/close-2/fc-apply.txt')), /== apply exit status: 0/);
  assert.equal(readFileSync(current, 'utf8'), target);
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(fencePlan('FENCE-OPEN', false, NEW)));
  const blockedPlan = run('plan.sh', ['FENCE-OPEN', COMMIT, 'open-already-started'], owner);
  assert.equal(blockedPlan.status, 0, blockedPlan.stdout + blockedPlan.stderr);
  const blockedPin = blockedPlan.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1];
  mkdirSync(join(rel, 'fences/open-already-started/apply-started'));
  assert.equal(run('apply.sh', ['FENCE-OPEN', COMMIT, blockedPin, 'open-already-started'], owner).status, 1, 'a previous start blocks another apply even before its log exists');
  assert.ok(!existsSync(join(rel, 'fences/open-already-started/fo-apply.txt')));
  const changedPlan = run('plan.sh', ['FENCE-OPEN', COMMIT, 'open-target-changes'], owner);
  assert.equal(changedPlan.status, 0, changedPlan.stdout + changedPlan.stderr);
  const changedPin = changedPlan.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1];
  const changeFolder = join(rel, 'fences/open-target-changes');
  const changing = run('apply.sh', ['FENCE-OPEN', COMMIT, changedPin, 'open-target-changes'], { ...owner, STUB_MUTATE_TARGET: join(changeFolder, 'fo.tfvars') });
  assert.equal(changing.status, 0, changing.stdout + changing.stderr);
  const changedLog = waitFor(join(changeFolder, 'fo-apply.txt'));
  assert.match(changedLog, /== apply exit status: 3/);
  assert.equal(readFileSync(current, 'utf8'), target, 'a target edited during apply is never published as canonical');
  // The next case independently supplies a fresh observed plan after the simulated partial/publication failure.
  const failurePlan = run('plan.sh', ['FENCE-OPEN', COMMIT, 'open-fails'], owner);
  assert.equal(failurePlan.status, 0, failurePlan.stdout + failurePlan.stderr);
  const failurePin = failurePlan.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1];
  assert.equal(run('apply.sh', ['FENCE-OPEN', COMMIT, failurePin, 'open-fails'], { CLAIM_OWNER: 'session-b' }).status, 1);
  assert.equal(run('apply.sh', ['FENCE-OPEN', COMMIT, failurePin, 'open-fails'], { ...owner, STUB_ACCOUNT: '999900001111' }).status, 1);
  assert.ok(!existsSync(join(rel, 'fences/open-fails/fo-apply.txt')));
  const failing = run('apply.sh', ['FENCE-OPEN', COMMIT, failurePin, 'open-fails'], { ...owner, STUB_APPLY_EXIT: '17' });
  assert.equal(failing.status, 0, failing.stdout + failing.stderr);
  const failedLog = waitFor(join(rel, 'fences/open-fails/fo-apply.txt'));
  assert.match(failedLog, /== apply exit status: 17/);
  assert.equal(readFileSync(current, 'utf8'), target, 'a failed apply does not publish its target as canonical');
  assert.equal(readFileSync(`${current}.sha256`, 'utf8').trim(), sha(current));
});

test('assessment operations: ON waits for the verified release and OFF never waits; both bind the var hashes and publish only the reviewed target', () => {
  writeCurrent(NEW);
  const original = readFileSync(current, 'utf8');
  const verificationFile = join(rel, 'verified-image.json');
  const signed = readFileSync(verificationFile, 'utf8');
  assert.match(signed, /"method":"signature"/, 'the fence test left a signature record covering the running image');
  const imageLog = readFileSync(join(rel, 'i-apply.txt'), 'utf8');
  assert.match(imageLog, /== apply exit status: 0/);
  const migrateStatus = join(rel, 'migrate-status.txt');
  writeFileSync(migrateStatus, 'pending: (none)\n');
  const shape = (mode) => writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(assessmentPlan(mode, NEW)));
  const pinOf = (r) => r.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1];
  const saveCurrent = (text) => { writeFileSync(current, text); writeFileSync(`${current}.sha256`, sha(current) + '\n'); };
  const startSerial = readFileSync(join(stubDir, 'serial'), 'utf8');

  // Switching ON waits for a verification record of the running image (a signature, or a break-glass record with a written reason), a finished
  // IMAGE apply and no pending migration. The medication fence keeps requiring a signature.
  shape('ASSESSMENT-ON');
  writeFileSync(verificationFile, '{}');
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-unsigned'], owner).status, 1, 'an empty verification marker is insufficient');
  const breakGlass = { format: 1, environment: 'staging', images: [NEW], recordedAt: '2026-11-04T00:00:00Z', method: 'break-glass',
    reason: 'CI release-image cannot sign in this account; founder approved an unsigned synthetic staging image' };
  writeFileSync(verificationFile, JSON.stringify({ ...breakGlass, reason: undefined }));
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-no-reason'], owner).status, 1, 'a break-glass record without a written reason is not enough');
  writeFileSync(verificationFile, JSON.stringify({ ...breakGlass, images: [OLD] }));
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-other-image'], owner).status, 1, 'a break-glass record for another image is not enough');
  writeFileSync(verificationFile, JSON.stringify({ ...breakGlass, environment: 'production' }));
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-production'], owner).status, 1, 'a production record is not enough');
  writeFileSync(verificationFile, JSON.stringify(breakGlass));
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(fencePlan('FENCE-OPEN', false, NEW)));
  const fenceOpen = run('plan.sh', ['FENCE-OPEN', COMMIT, 'open-break-glass'], owner);
  assert.equal(fenceOpen.status, 1, 'the medication fence still refuses a break-glass record');
  assert.match(fenceOpen.stderr, /signature-verification record/);
  shape('ASSESSMENT-ON');
  const unsignedOn = run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-break-glass'], owner);
  assert.equal(unsignedOn.status, 0, 'a break-glass record with a reason, naming the running image, is accepted: ' + unsignedOn.stdout + unsignedOn.stderr);
  writeFileSync(verificationFile, '{}');
  assert.equal(run('apply.sh', ['ASSESSMENT-ON', COMMIT, pinOf(unsignedOn), 'on-break-glass'], owner).status, 1, 'the record is checked again at apply');
  assert.ok(!existsSync(join(rel, 'assessments/on-break-glass/ae-apply.txt')));
  writeFileSync(verificationFile, JSON.stringify(breakGlass));
  const unsignedApply = run('apply.sh', ['ASSESSMENT-ON', COMMIT, pinOf(unsignedOn), 'on-break-glass'], owner);
  assert.equal(unsignedApply.status, 0, 'the apply accepts the same break-glass record: ' + unsignedApply.stdout + unsignedApply.stderr);
  assert.match(waitFor(join(rel, 'assessments/on-break-glass/ae-apply.txt')), /== apply exit status: 0/);
  saveCurrent(original); writeFileSync(join(stubDir, 'serial'), startSerial); // put the stack back as the rest of this test expects it
  // The fence: planned on a signature, then the record turns into a break-glass one before the apply, which must refuse.
  writeFileSync(verificationFile, signed);
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(fencePlan('FENCE-OPEN', false, NEW)));
  const openSigned = run('plan.sh', ['FENCE-OPEN', COMMIT, 'open-signed'], owner);
  assert.equal(openSigned.status, 0, openSigned.stdout + openSigned.stderr);
  writeFileSync(verificationFile, JSON.stringify(breakGlass));
  const openRefused = run('apply.sh', ['FENCE-OPEN', COMMIT, pinOf(openSigned), 'open-signed'], owner);
  assert.equal(openRefused.status, 1, 'the medication fence refuses a break-glass record at apply too');
  assert.match(openRefused.stderr, /signature-verification record/);
  writeFileSync(verificationFile, signed);
  shape('ASSESSMENT-ON');
  writeFileSync(join(rel, 'i-apply.txt'), '== apply exit status: 9\n');
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-incomplete-image'], owner).status, 1);
  writeFileSync(join(rel, 'i-apply.txt'), imageLog);
  writeFileSync(migrateStatus, 'pending: 0071\n');
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-pending-migration'], owner).status, 1);
  writeFileSync(migrateStatus, 'pending: (none)\n');
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT], owner).status, 1, 'an operation id is required');
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT, '../escape'], owner).status, 1);
  writeFileSync(join(stubDir, 'plan.json'), JSON.stringify(fencePlan('FENCE-CLOSE', true, NEW)));
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-wrong-shape'], owner).status, 1, 'a medication plan is not an assessment plan');
  assert.ok(!existsSync(join(rel, 'assessments/on-wrong-shape/ae.tfplan.meta.json')), 'a plan the release check refuses is not recorded');
  shape('ASSESSMENT-ON');

  const planned = run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-1'], owner);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr); quiet(planned);
  const folder = join(rel, 'assessments/on-1');
  const pin = pinOf(planned);
  assert.ok(pin);
  const target = readFileSync(join(folder, 'ae.tfvars'), 'utf8');
  assert.equal(readFileSync(join(folder, 'source.tfvars'), 'utf8'), original);
  assert.equal(target, original + 'synthetic_assessment_enabled = true\n');
  const metadata = JSON.parse(readFileSync(join(folder, 'ae.tfplan.meta.json'), 'utf8'));
  assert.equal(metadata.mode, 'ASSESSMENT-ON');
  assert.equal(metadata.sourceVarSha256, sha(current));
  assert.equal(metadata.varSha256, sha(join(folder, 'ae.tfvars')));
  assert.equal(run('apply.sh', ['ASSESSMENT-ON', COMMIT, '0'.repeat(64), 'on-1'], owner).status, 1);
  saveCurrent(target); // Even a changed canonical file with a valid self-hash must not pass.
  const changedSource = run('apply.sh', ['ASSESSMENT-ON', COMMIT, pin, 'on-1'], owner);
  assert.equal(changedSource.status, 1); assert.match(changedSource.stderr, /sourceVarSha256|stale|source variables changed/);
  saveCurrent(original);
  writeFileSync(join(stubDir, 'serial'), String(Number(startSerial) + 1));
  assert.equal(run('apply.sh', ['ASSESSMENT-ON', COMMIT, pin, 'on-1'], owner).status, 1, 'state drift must refuse the plan');
  writeFileSync(join(stubDir, 'serial'), startSerial);
  writeFileSync(migrateStatus, 'pending: 0071\n');
  assert.equal(run('apply.sh', ['ASSESSMENT-ON', COMMIT, pin, 'on-1'], owner).status, 1, 'switching on is rechecked at apply');
  writeFileSync(migrateStatus, 'pending: (none)\n');
  assert.equal(run('apply.sh', ['ASSESSMENT-ON', COMMIT, pin, 'on-1'], { CLAIM_OWNER: 'session-b' }).status, 1, 'only the claim holder applies');
  const started = run('apply.sh', ['ASSESSMENT-ON', COMMIT, pin, 'on-1'], owner);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(waitFor(join(folder, 'ae-apply.txt')), /== apply exit status: 0/);
  assert.equal(readFileSync(current, 'utf8'), target);
  assert.equal(readFileSync(`${current}.sha256`, 'utf8').trim(), sha(current));
  assert.equal(run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-1'], owner).status, 1, 'old operation records are not overwritten');
  assert.equal(run('apply.sh', ['ASSESSMENT-ON', COMMIT, pin, 'on-1'], owner).status, 1, 'an applied operation cannot be applied again');

  // A target edited during the apply is never published as canonical, and a failed apply publishes nothing.
  shape('ASSESSMENT-OFF');
  writeFileSync(verificationFile, '{}'); writeFileSync(join(rel, 'i-apply.txt'), '== apply exit status: 9\n'); writeFileSync(migrateStatus, 'pending: 0071\n');
  const changing = run('plan.sh', ['ASSESSMENT-OFF', COMMIT, 'off-target-changes'], owner);
  assert.equal(changing.status, 0, 'switching OFF waits for nothing: ' + changing.stdout + changing.stderr);
  const changeFolder = join(rel, 'assessments/off-target-changes');
  const edited = run('apply.sh', ['ASSESSMENT-OFF', COMMIT, pinOf(changing), 'off-target-changes'], { ...owner, STUB_MUTATE_TARGET: join(changeFolder, 'ad.tfvars') });
  assert.equal(edited.status, 0, edited.stdout + edited.stderr);
  assert.match(waitFor(join(changeFolder, 'ad-apply.txt')), /== apply exit status: 3/);
  assert.equal(readFileSync(current, 'utf8'), target, 'a target edited during apply is never published as canonical');
  const failing = run('plan.sh', ['ASSESSMENT-OFF', COMMIT, 'off-fails'], owner);
  assert.equal(failing.status, 0, failing.stdout + failing.stderr);
  const failed = run('apply.sh', ['ASSESSMENT-OFF', COMMIT, pinOf(failing), 'off-fails'], { ...owner, STUB_APPLY_EXIT: '17' });
  assert.equal(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(waitFor(join(rel, 'assessments/off-fails/ad-apply.txt')), /== apply exit status: 17/);
  assert.equal(readFileSync(current, 'utf8'), target, 'a failed apply does not publish its target as canonical');

  // The way back: OFF, with the release evidence gone, still plans and applies, and rewrites only its own line.
  const off = run('plan.sh', ['ASSESSMENT-OFF', COMMIT, 'off-1'], owner);
  assert.equal(off.status, 0, off.stdout + off.stderr); quiet(off);
  assert.equal(readFileSync(join(rel, 'assessments/off-1/ad.tfvars'), 'utf8'), original + 'synthetic_assessment_enabled = false\n');
  const offApply = run('apply.sh', ['ASSESSMENT-OFF', COMMIT, pinOf(off), 'off-1'], owner);
  assert.equal(offApply.status, 0, offApply.stdout + offApply.stderr);
  assert.match(waitFor(join(rel, 'assessments/off-1/ad-apply.txt')), /== apply exit status: 0/);
  assert.equal(readFileSync(current, 'utf8'), original + 'synthetic_assessment_enabled = false\n');
  assert.ok(existsSync(join(folder, 'ae.tfplan.meta.json')), 'the earlier switching-on evidence remains');

  // Switching on again rewrites the same line in place.
  writeFileSync(verificationFile, signed); writeFileSync(join(rel, 'i-apply.txt'), imageLog); writeFileSync(migrateStatus, 'pending: (none)\n');
  shape('ASSESSMENT-ON');
  const again = run('plan.sh', ['ASSESSMENT-ON', COMMIT, 'on-2'], owner);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(readFileSync(join(rel, 'assessments/on-2/ae.tfvars'), 'utf8'), original + 'synthetic_assessment_enabled = true\n');
  assert.ok(!existsSync(join(rel, 'fences/on-1')), 'assessment evidence never lands in the fence folders');
  mkdirSync(join(rel, 'assessments/on-2/apply-started'));
  assert.equal(run('apply.sh', ['ASSESSMENT-ON', COMMIT, pinOf(again), 'on-2'], owner).status, 1, 'a previous start blocks another apply even before its log exists');
  assert.ok(!existsSync(join(rel, 'assessments/on-2/ae-apply.txt')));
});
