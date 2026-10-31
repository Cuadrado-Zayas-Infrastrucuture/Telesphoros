// Tests for scripts/staging/release/{claim,plan,apply,apply-run}.sh (spec 027, PR 3a). Imported by infrastructure/terraform/guard.test.mjs.
// The scripts run for real against stand-ins: an `aws` that answers the identity and the running image from files, and a `terraform` that keeps
// a state serial in a file (apply increments it), writes a distinct plan per call, and shows a plan JSON the test chooses. A real git
// repository is the backend clone. What this cannot prove: what real Terraform does with a stale saved plan (see release-rehearsal.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';

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
stub('aws', `case "$*" in
  *"--query Account"*) echo "${ACCOUNT}" ;;
  *"--query Arn"*) echo "arn:aws:sts::${ACCOUNT}:assumed-role/StagingRole/s" ;;
  *describe-services*) echo "arn:aws:ecs:us-east-2:${ACCOUNT}:task-definition/telesphoros-staging-api:4" ;;
  *describe-task-definition*) cat "$STUB/running" ;;
  *) echo "unexpected aws $*" >&2; exit 99 ;;
esac`);
stub('terraform', `case "$*" in
  version) echo "Terraform v1.16.5" ;;
  *"state pull"*) echo "{\\"version\\":4,\\"serial\\":$(cat "$STUB/serial"),\\"lineage\\":\\"l-1\\",\\"outputs\\":{\\"x\\":{\\"value\\":\\"SENTINEL\\"}}}" ;;
  *"show -json"*) cat "$STUB/plan.json" ;;
  *"show -no-color"*) echo "Plan: 0 to add, 1 to change, 0 to destroy." ;;
  *" plan "*) for a in "$@"; do case "$a" in -out=*) printf 'plan %s %s\\n' "$RANDOM$RANDOM" "$*" > "\${a#-out=}" ;; esac; done ;;
  *" apply "*) echo $(( $(cat "$STUB/serial") + 1 )) > "$STUB/serial"; exit "\${STUB_APPLY_EXIT:-0}" ;;
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
  assert.match(readFileSync(current, 'utf8'), new RegExp(`api_image = "${NEW.replace(/[.]/g, '\\.')}"`));
  assert.equal(readFileSync(`${current}.sha256`, 'utf8').trim(), sha(current));
  for (const f of ['x.tfplan', 'x.tfplan.meta.json']) rmSync(join(rel, f), { force: true });
  const behind = run('plan.sh', ['INFRA', COMMIT], owner);
  assert.match(behind.stderr, /ECS runs sha256:a{64}, but current\.tfvars names sha256:b{64}: the var file is stale/, 'ECS has not rolled yet');
  writeFileSync(join(stubDir, 'running'), `${NEW}\n`);
  writeFileSync(current, `${readFileSync(current, 'utf8')}# edited\n`);
  rmSync(join(rel, 'x.tfplan'), { force: true });
  assert.match(run('plan.sh', ['INFRA', COMMIT], owner).stderr, /does not match its recorded sha256/);
});
