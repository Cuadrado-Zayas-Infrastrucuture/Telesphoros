// Tests for scripts/staging/staging-status.sh (spec 027, PR 2). Imported by infrastructure/terraform/guard.test.mjs, so `pnpm test:infra` runs it.
// The script runs for real against stand-ins: an `aws` and a `curl` that answer from STUB_* variables, a `terraform` whose state and plan carry a
// sentinel that must never reach the output, and a real git repository as the backend clone. What this cannot prove: that AWS answers the
// same way, or that the real Terraform's exit codes match (`-detailed-exitcode` is documented as 0, 1, 2).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const script = join(root, 'scripts/staging/staging-status.sh');
const box = mkdtempSync(join(tmpdir(), 'staging-status-sh-'));
after(() => rmSync(box, { recursive: true, force: true }));

const ACCOUNT = '123456789012';
const DIGEST = `sha256:${'d5'.repeat(32)}`;
const bin = join(box, 'bin');
mkdirSync(bin);
const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
stub('aws', `case "$*" in
  *get-caller-identity*) echo "$STUB_ACCOUNT" ;;
  *describe-services*"--services telesphoros-staging-worker "*) echo "arn:aws:ecs:us-east-2:$STUB_ACCOUNT:task-definition/telesphoros-staging-worker:3" ;;
  *describe-services*"--services telesphoros-staging-api "*) echo "arn:aws:ecs:us-east-2:$STUB_ACCOUNT:task-definition/telesphoros-staging-api:$STUB_API_REV" ;;
  *describe-task-definition*) echo "$STUB_ACCOUNT.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api@${DIGEST}" ;;
  *describe-alarms*) [ -n "$STUB_ALARMS_REFUSED" ] && { echo "An error occurred (AccessDenied) when calling DescribeAlarms" >&2; exit 254; }; echo 31 ;;
  *list-distributions*) echo E1EXAMPLE ;;
  *get-distribution*) echo "/assets/*" ;;
  *) echo "unexpected aws $*" >&2; exit 99 ;;
esac`);
stub('curl', 'printf 200');
stub('terraform', `case "$*" in
  version) echo "Terraform v1.16.5" ;;
  *state\\ pull*) echo '{"version":4,"serial":42,"lineage":"l-1","outputs":{"x":{"value":"SENTINEL-STATE"}}}' ;;
  *show\\ -json*) echo '{"resource_changes":[{"address":"aws_cloudfront_distribution.web[0]","change":{"actions":["update"],"after":{"x":"SENTINEL-PLAN"}}}]}' ;;
  *\\ plan\\ *) echo "SENTINEL-PLAN-LOG"; exit "$STUB_PLAN_EXIT" ;;
  *) exit 99 ;;
esac`);

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const clone = join(box, 'clone');
mkdirSync(join(clone, 'apps/backend/migrations'), { recursive: true });
mkdirSync(join(clone, 'infrastructure/terraform'), { recursive: true });
mkdirSync(join(clone, 'docs/ops'), { recursive: true });
git(clone, 'init', '-q', '-b', 'main');
writeFileSync(join(clone, 'apps/backend/migrations/0064_x.up.sql'), '');
writeFileSync(join(clone, 'infrastructure/terraform/main.tf'), '');
git(clone, 'add', '.');
git(clone, 'commit', '-q', '-m', 'the image and the applied commit');
const applied = git(clone, 'rev-parse', 'HEAD');
const facts = (extra = {}) => JSON.stringify({
  checked: '2026-10-31', appliedCommit: applied, image: { digest: DIGEST, commit: applied }, taskDefinitions: { api: 4, worker: 3 },
  alarms: 31, newestMigration: '0064', cloudfrontCachePaths: ['/assets/*'], acceptedExceptions: [], ...extra,
});
writeFileSync(join(clone, 'docs/ops/staging-expected.json'), facts());
git(clone, 'add', '.');
git(clone, 'commit', '-q', '-m', 'facts');
git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

const priv = join(box, 'private');
mkdirSync(join(priv, 'staging'), { recursive: true });
mkdirSync(join(priv, 'maindata'));
writeFileSync(join(priv, 'staging/current.tfvars'), 'SENTINEL-VARS = "x"\n');
const stackEnv = (extra = '') => writeFileSync(join(priv, 'staging/stack.env'), [
  `STAGING_ACCOUNT_ID=${ACCOUNT}`, `BACKEND_CLONE=${clone}`, `TERRAFORM=${join(bin, 'terraform')}`, `TF_DATA_DIR=${join(priv, 'maindata')}`,
  `STAGING_VAR_FILE=${join(priv, 'staging/current.tfvars')}`, extra,
].join('\n'));

const run = (env = {}) => spawnSync('bash', [script], {
  encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: box, PRIVATE_DIR: priv, TMPDIR: box, STUB_ACCOUNT: ACCOUNT, STUB_API_REV: '4', STUB_PLAN_EXIT: '0', STUB_ALARMS_REFUSED: '', ...env },
});
const noSentinel = (r) => { for (const s of [r.stdout, r.stderr]) assert.ok(!s.includes('SENTINEL'), s); };

test('staging that matches its facts, with no plan changes, exits 0 and prints no state, plan or variable value', () => {
  stackEnv();
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /current: nothing to do/);
  assert.match(r.stdout, /state serial: 42/);
  noSentinel(r);
});

test('each kind of staleness fails the run and is named', () => {
  stackEnv();
  const cases = [
    [{ STUB_API_REV: '5' }, /api\.revision\s+4\s+5\s+DRIFT/],
    [{ STUB_ALARMS_REFUSED: '1' }, /alarms\s+31\s+refused\s+unknown/],
    [{ STUB_PLAN_EXIT: '2' }, /plan: 1 change\(s\)[\s\S]*update aws_cloudfront_distribution\.web\[0\]/],
    [{ STUB_PLAN_EXIT: '1' }, /plan: failed/],
  ];
  for (const [env, shows] of cases) {
    const r = run(env);
    assert.equal(r.status, 1, JSON.stringify(env) + r.stdout + r.stderr);
    assert.match(r.stdout, shows);
    noSentinel(r);
  }
  writeFileSync(join(clone, 'infrastructure/terraform/main.tf'), '# merged later\n');
  git(clone, 'commit', '-q', '-am', 'Merge pull request #999 (Terraform, not applied)');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const late = run();
  assert.equal(late.status, 1);
  assert.match(late.stdout, /merged after the applied commit, under infrastructure\/terraform\/: 1\n {2}[0-9a-f]+ Merge pull request #999/);
  git(clone, 'reset', '-q', '--hard', 'HEAD~1');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
});

test('a missing var file, a wrong account and a missing stack.env stop or fail the run, never pass it', () => {
  stackEnv('STAGING_VAR_FILE=');
  const noVars = run();
  assert.equal(noVars.status, 1);
  assert.match(noVars.stdout, /plan: not run: no canonical var file/);
  stackEnv();
  const wrong = run({ STUB_ACCOUNT: '210987654321' });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /wrong account/);
  const none = run({ PRIVATE_DIR: join(box, 'nowhere') });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no .*stack\.env/);
});

test('saved plans: current, stale, unrecorded and legacy; and the claim', () => {
  stackEnv();
  const rel = join(priv, 'releases/abc');
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, 'i.tfplan'), '');
  writeFileSync(join(rel, 'i.tfplan.meta.json'), '{"serial":42}');
  assert.equal(run().status, 0, 'a plan made at the current serial');
  writeFileSync(join(rel, 'i.tfplan.meta.json'), '{"serial":41}');
  const stale = run();
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /saved plan releases\/abc\/i\.tfplan: STALE \(serial 41\)/);
  rmSync(join(priv, 'releases'), { recursive: true });
  mkdirSync(join(priv, 'release-old'));
  writeFileSync(join(priv, 'release-old/m.tfplan'), '');
  const legacy = run();
  assert.equal(legacy.status, 0);
  assert.match(legacy.stdout, /1 saved plans from before spec 027/);
  mkdirSync(join(priv, 'staging/claim'));
  writeFileSync(join(priv, 'staging/claim/owner.json'), JSON.stringify({ owner: 'session-a', reason: 'release', started: '2000-01-01T00:00:00Z' }));
  const abandoned = run();
  assert.equal(abandoned.status, 1);
  assert.match(abandoned.stdout, /claim: held by session-a .* ABANDONED/);
  rmSync(join(priv, 'staging/claim'), { recursive: true });
});
