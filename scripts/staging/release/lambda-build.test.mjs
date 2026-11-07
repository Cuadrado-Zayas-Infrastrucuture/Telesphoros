// Tests for the Lambda bundles a release plan builds (lib.sh build_lambdas, spec 027 T022). Imported by infrastructure/terraform/guard.test.mjs.
// plan.sh and apply.sh run for real against stand-ins: a `pnpm` that records each call and writes a dist the way the test asks, and a
// `terraform` whose plan zips each dist into .build/<name>.zip the way archive_file does. What this cannot prove: what the archive provider puts
// in a zip (lambda-build-rehearsal.test.mjs runs it for real) and whether Lambda reads a file; the scripts refuse a mode other than 644 instead.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const here = new URL('.', import.meta.url).pathname;
const box = mkdtempSync(join(tmpdir(), 'lambda-build-'));
after(() => rmSync(box, { recursive: true, force: true }));

const ACCOUNT = '111122223333';
const IMAGE = `${ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@sha256:${'a'.repeat(64)}`;
const PNPM = '10.28.0';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const bin = join(box, 'bin');
mkdirSync(bin);
const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
stub('aws', `case "$*" in
  *"--query Account"*) echo "${ACCOUNT}" ;;
  *describe-services*) echo "arn:aws:ecs:us-east-2:${ACCOUNT}:task-definition/telesphoros-staging-api:4" ;;
  *describe-task-definition*) echo "${IMAGE}" ;;
  *) echo "unexpected aws $*" >&2; exit 99 ;;
esac`);
stub('pnpm', `case "$1" in
  --version) echo "\${STUB_PNPM:-${PNPM}}" ;;
  install) echo "install $*" >> "$STUB/calls"; exit "\${STUB_INSTALL_EXIT:-0}" ;;
  run) echo "build $(basename "$PWD") $(umask)" >> "$STUB/calls"; [ "\${STUB_BUILD_EXIT:-0}" = 0 ] || exit "$STUB_BUILD_EXIT"
    mkdir -p dist; [ -n "\${STUB_BUILD_EMPTY:-}" ] || printf 'code %s\\n' "\${STUB_CODE:-v1}" > dist/index.mjs
    [ -z "\${STUB_BUILD_PRIVATE:-}" ] || chmod 600 dist/index.mjs; [ -z "\${STUB_BUILD_DIRTY:-}" ] || echo edited >> ../../../package.json ;;
  *) echo "unexpected pnpm $*" >&2; exit 99 ;;
esac`);
stub('terraform', `dir=""; for a in "$@"; do case "$a" in -chdir=*) dir="\${a#-chdir=}" ;; esac; done
case "$*" in
  version) echo "Terraform v1.16.5" ;;
  *"state pull"*) echo "{\\"version\\":4,\\"serial\\":$(cat "$STUB/serial"),\\"lineage\\":\\"l-1\\"}" ;;
  *"show -json"*) cat "$STUB/plan.json" ;;
  *"show -no-color"*) echo "Plan: 1 to add, 0 to change, 0 to destroy." ;;
  *" plan "*) echo plan >> "$STUB/calls"; mkdir -p "$dir/.build"
    for d in "$dir"/../lambda/*/dist; do [ -d "$d" ] && cat "$d"/* > "$dir/.build/$(basename "$(dirname "$d")").zip"; done
    for a in "$@"; do case "$a" in -out=*) printf 'plan %s\\n' "$RANDOM$RANDOM" > "\${a#-out=}" ;; esac; done ;;
  *" apply "*) echo $(( $(cat "$STUB/serial") + 1 )) > "$STUB/serial" ;;
  *) echo "unexpected terraform $*" >&2; exit 99 ;;
esac`);
const stubDir = join(box, 'stub');
mkdirSync(stubDir);
writeFileSync(join(stubDir, 'serial'), '7');
writeFileSync(join(stubDir, 'plan.json'), JSON.stringify({ format_version: '1.2', complete: true, applyable: true, errored: false,
  resource_drift: [], output_changes: {},
  variables: { deployment_profile: { value: 'synthetic' }, environment: { value: 'staging' }, region: { value: 'us-east-2' },
    api_image: { value: IMAGE }, api_migrate_image: { value: IMAGE } },
  resource_changes: [{ address: 'aws_cloudwatch_metric_alarm.x[0]', mode: 'managed', type: 'aws_cloudwatch_metric_alarm',
    change: { actions: ['create'], before: null, after: {} } }] }));

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const clone = join(box, 'clone');
const lambda = join(clone, 'infrastructure/lambda/demo');
const tfdir = join(clone, 'infrastructure/terraform');
mkdirSync(lambda, { recursive: true });
mkdirSync(tfdir, { recursive: true });
writeFileSync(join(clone, 'package.json'), JSON.stringify({ packageManager: `pnpm@${PNPM}` }));
writeFileSync(join(clone, '.nvmrc'), `${process.version.slice(1)}\n`);
writeFileSync(join(clone, '.gitignore'), 'dist/\n.build/\n');
writeFileSync(join(lambda, 'package.json'), JSON.stringify({ name: 'demo', scripts: { build: 'tsup' } }));
writeFileSync(join(tfdir, 'main.tf'), '');
git(clone, 'init', '-q', '-b', 'main');
git(clone, 'add', '.');
git(clone, 'commit', '-q', '-m', 'release');
const COMMIT = git(clone, 'rev-parse', 'HEAD');

const priv = join(box, 'private');
const staging = join(priv, 'staging');
const rel = join(priv, 'releases', COMMIT);
mkdirSync(staging, { recursive: true });
mkdirSync(join(priv, 'maindata'));
writeFileSync(join(staging, 'stack.env'), [`STAGING_ACCOUNT_ID=${ACCOUNT}`, `BACKEND_CLONE=${clone}`, `TERRAFORM=${join(bin, 'terraform')}`,
  `TF_DATA_DIR=${join(priv, 'maindata')}`].join('\n'));
const current = join(staging, 'current.tfvars');
writeFileSync(current, `api_image = "${IMAGE}"\napi_migrate_image = "${IMAGE}"\n`);
writeFileSync(`${current}.sha256`, `${sha(current)}\n`);

const run = (script, args, env = {}) => spawnSync('bash', [join(here, script), ...args], {
  encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: box, PRIVATE_DIR: priv, TMPDIR: box, STUB: stubDir, CLAIM_OWNER: 'session-a', ...env },
});
const calls = () => (existsSync(join(stubDir, 'calls')) ? readFileSync(join(stubDir, 'calls'), 'utf8').trim().split('\n') : []);
const fresh = () => {
  rmSync(join(stubDir, 'calls'), { force: true });
  for (const f of ['x.tfplan', 'x.tfplan.meta.json', 'x.tfplan.bundles', 'x-apply.txt']) rmSync(join(rel, f), { force: true });
};
const plan = (env) => {
  fresh();
  const r = run('plan.sh', ['INFRA', COMMIT], env);
  return { ...r, pin: r.stdout.match(/plan sha256: ([0-9a-f]{64})/)?.[1] };
};
const waitFor = (file) => {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(file) && /== apply exit status: \d+/.test(readFileSync(file, 'utf8'))) return readFileSync(file, 'utf8');
    spawnSync('sleep', ['0.1']);
  }
  throw new Error(`no exit line in ${file}`);
};
const zip = join(tfdir, '.build/demo.zip');
const bundles = join(rel, 'x.tfplan.bundles');

test('claim', () => assert.equal(run('claim.sh', ['take', 'session-a', 'lambda bundles']).status, 0));

test('every plan builds each Lambda first, from an empty dist, readable by Lambda, and records the zip it made', () => {
  mkdirSync(join(lambda, 'dist'));
  writeFileSync(join(lambda, 'dist/old.mjs'), 'an older build\n');
  mkdirSync(join(tfdir, '.build'));
  writeFileSync(zip, 'an older zip\n');
  const p = plan();
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.deepEqual(calls(), ['install install --frozen-lockfile', 'build demo 0022', 'plan'], 'install, then each build under umask 022, then the plan');
  assert.ok(!existsSync(join(lambda, 'dist/old.mjs')), 'a file from an older build is not packaged');
  assert.equal(statSync(join(lambda, 'dist/index.mjs')).mode & 0o777, 0o644);
  assert.equal(statSync(join(lambda, 'dist')).mode & 0o777, 0o755);
  assert.equal(readFileSync(zip, 'utf8'), 'code v1\n');
  assert.equal(readFileSync(bundles, 'utf8'), `${sha(zip)} demo\n`);
  assert.match(p.stdout, /built: demo/);
});

test('apply refuses a zip rebuilt after the plan, and a plan without a bundle record; the planned zip applies', () => {
  const p = plan();
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const planned = readFileSync(zip);
  writeFileSync(zip, 'code v2\n');
  const rebuilt = run('apply.sh', ['INFRA', COMMIT, p.pin]);
  assert.equal(rebuilt.status, 1);
  assert.match(rebuilt.stderr, /the demo Lambda bundle changed after the plan: plan again/);
  rmSync(zip);
  assert.match(run('apply.sh', ['INFRA', COMMIT, p.pin]).stderr, /the demo Lambda bundle changed after the plan/, 'a deleted zip too');
  writeFileSync(zip, planned);
  const record = readFileSync(bundles);
  rmSync(bundles);
  assert.match(run('apply.sh', ['INFRA', COMMIT, p.pin]).stderr, /no bundle record next to the plan/);
  assert.ok(!existsSync(join(rel, 'x-apply.txt')), 'nothing was started');
  writeFileSync(bundles, record);
  const applied = run('apply.sh', ['INFRA', COMMIT, p.pin]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(waitFor(join(rel, 'x-apply.txt')), /== apply exit status: 0/);
});

test('a plan stops before Terraform when a bundle cannot be trusted', () => {
  const cases = [
    [{ STUB_PNPM: '9.15.0' }, /pnpm is not the clone's packageManager \(pnpm@10\.28\.0\)/],
    [{ STUB_INSTALL_EXIT: '1' }, /pnpm install failed in the clone/],
    [{ STUB_BUILD_EXIT: '2' }, /the demo Lambda did not build/],
    [{ STUB_BUILD_EMPTY: '1' }, /the demo Lambda built nothing into dist/],
    [{ STUB_BUILD_PRIVATE: '1' }, /the demo bundle has a file Lambda cannot read/],
    [{ STUB_BUILD_DIRTY: '1' }, /tracked changes in the clone/],
  ];
  for (const [env, why] of cases) {
    const p = plan(env);
    git(clone, 'checkout', '--', 'package.json');
    assert.equal(p.status, 1, `${JSON.stringify(env)}: ${p.stdout}${p.stderr}`);
    assert.match(p.stderr, why);
    assert.ok(!calls().includes('plan'), `${JSON.stringify(env)}: Terraform did not plan`);
    assert.ok(!existsSync(join(rel, 'x.tfplan')) && !existsSync(bundles));
  }
  assert.ok(!existsSync(zip), 'the older zip was removed before the build');
});
