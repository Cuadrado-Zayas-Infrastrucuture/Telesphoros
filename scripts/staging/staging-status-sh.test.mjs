// Tests for scripts/staging/staging-status.sh (spec 027, PR 2). Imported by infrastructure/terraform/guard.test.mjs, so `pnpm test:infra` runs it.
// The script runs for real against stand-ins: an `aws` and a `curl` that answer from STUB_* variables, a `terraform` whose state and plan carry a
// sentinel that must never reach the output, and a real git repository as the backend clone. What this cannot prove: that AWS answers the
// same way, or that the real Terraform's exit codes match (`-detailed-exitcode` is documented as 0, 1, 2).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
// The processes this machine runs are never read: `pgrep -x NAME` and `ps -o args= -p PID` answer from STUB_PROCS, one `PID NAME COMMAND LINE`
// per line, empty (nothing running) by default; STUB_PGREP_EXIT makes pgrep fail. The check itself is tested in scripts/staging/terraform-running.test.mjs.
stub('pgrep', [
  '[ -z "${STUB_PGREP_EXIT:-}" ] || exit "$STUB_PGREP_EXIT"',
  'found=1; while read -r pid name _; do [ -n "$pid" ] && [ "$name" = "${!#}" ] && { echo "$pid"; found=0; }; done <<< "${STUB_PROCS:-}"; exit $found',
].join('\n'));
stub('ps', 'while read -r pid _ args; do [ "$pid" = "${!#}" ] && { echo "$args"; exit 0; }; done <<< "${STUB_PROCS:-}"; exit 1');
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
// Only the real readiness path answers 200 (apps/backend/src/health/health.controller.ts, GET /api/v1/ready); any other URL is a 404.
stub('curl', 'case "$*" in *https://api.staging.telesphoros.app/api/v1/ready*) printf 200 ;; *) printf 404 ;; esac');
// STUB_TF_SLOW: write more lines after a pause, as a Terraform that checks for updates does (the reader may have stopped by then).
stub('terraform', `case "$*" in
  version) echo "\${STUB_TF_VERSION:-Terraform v1.16.5}"; if [ -n "\${STUB_TF_SLOW:-}" ]; then sleep 0.2; echo "on darwin_arm64"; echo "Your version of Terraform is out of date!"; fi ;;
  *state\\ pull*) echo '{"version":4,"serial":42,"lineage":"l-1","outputs":{"x":{"value":"SENTINEL-STATE"}}}' ;;
  *show\\ -json*) echo '{"resource_changes":[{"address":"aws_cloudfront_distribution.web[0]","change":{"actions":["update"],"after":{"x":"SENTINEL-PLAN"}}}]}' ;;
  *\\ plan\\ *) echo "$*" > "$TMPDIR/plan-args"; echo "SENTINEL-PLAN-LOG"; exit "$STUB_PLAN_EXIT" ;;
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
const current = join(priv, 'staging/current.tfvars');
const writeCurrent = () => {
  writeFileSync(current, 'SENTINEL-VARS = "x"\n');
  writeFileSync(`${current}.sha256`, `${createHash('sha256').update(readFileSync(current)).digest('hex')}\n`);
};
writeCurrent();
const stackEnv = (extra = '') => writeFileSync(join(priv, 'staging/stack.env'), [
  `STAGING_ACCOUNT_ID=${ACCOUNT}`, `BACKEND_CLONE=${clone}`, `TERRAFORM=${join(bin, 'terraform')}`, `TF_DATA_DIR=${join(priv, 'maindata')}`, extra,
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

test('the plan is not run while a real Terraform runs or the process list cannot be read; a stand-in or a command line that mentions it does not stop it', () => {
  stackEnv();
  const busy = run({ STUB_PROCS: '4242 terraform /opt/homebrew/bin/terraform -chdir=/x plan -input=false' });
  assert.equal(busy.status, 1, busy.stdout + busy.stderr);
  assert.match(busy.stdout, /plan: not run: another terraform process is running/);
  for (const procs of [
    `4242 terraform bash ${join(bin, 'terraform')} -chdir=/x plan -input=false`,
    '4243 zsh zsh -c sleep 600; : terraform -chdir=/x plan -input=false',
    '4244 node node /x/codex.js exec run terraform -chdir=/x plan',
  ]) {
    const quiet = run({ STUB_PROCS: procs });
    assert.equal(quiet.status, 0, `${procs}\n${quiet.stdout}${quiet.stderr}`);
    assert.match(quiet.stdout, /current: nothing to do/);
  }
  const refused = run({ STUB_PGREP_EXIT: '3' });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /plan: not run: the process list could not be read, so another terraform process cannot be ruled out/);
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
  const merge = (path, text, subject) => {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), text);
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', subject);
    git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  };
  merge('infrastructure/terraform/extra.test.mjs', '// a test\n', 'Merge pull request #997 (a test only)');
  assert.match(run().stdout, /merged after the applied commit, Terraform inputs: none/, 'a test an apply never reads is not unapplied');
  merge('infrastructure/lambda/x/src/index.ts', 'export {};\n', 'Merge pull request #998 (Lambda source)');
  merge('infrastructure/terraform/main.tf', '# merged later\n', 'Merge pull request #999 (Terraform, not applied)');
  const late = run();
  assert.equal(late.status, 1);
  assert.match(late.stdout, /merged after the applied commit, Terraform inputs: 2\n {2}[0-9a-f]+ Merge pull request #999[^\n]*\n {2}[0-9a-f]+ Merge pull request #998/);
  git(clone, 'reset', '-q', '--hard', 'HEAD~3');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
});

test('the Terraform version check reads the whole output: a binary still writing after the first line passes, another version stops', () => {
  stackEnv();
  const slow = run({ STUB_TF_SLOW: '1' });
  assert.equal(slow.status, 0, slow.stdout + slow.stderr);
  const other = run({ STUB_TF_VERSION: 'Terraform v1.15.0' });
  assert.equal(other.status, 2);
  assert.match(other.stderr, /TERRAFORM is not 1\.16\.5/);
});

test('the plan reads current.tfvars, the release steps\' var file, only while it matches its sha256; STAGING_VAR_FILE is not read', () => {
  const elsewhere = join(box, 'other.tfvars');
  writeFileSync(elsewhere, 'SENTINEL-OTHER = "y"\n');
  stackEnv(`STAGING_VAR_FILE=${elsewhere}`);
  rmSync(join(box, 'plan-args'), { force: true });
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(readFileSync(join(box, 'plan-args'), 'utf8'), new RegExp(`-var-file=${current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), 'planned with current.tfvars');
  stackEnv();
  writeFileSync(current, 'SENTINEL-VARS = "edited"\n');
  rmSync(join(box, 'plan-args'), { force: true });
  const edited = run();
  assert.equal(edited.status, 1);
  assert.match(edited.stdout, /plan: not run: current\.tfvars does not match its recorded sha256 \(edited by hand\)/);
  assert.ok(!existsSync(join(box, 'plan-args')), 'no plan was made with an edited var file');
  noSentinel(edited);
  for (const gone of [current, `${current}.sha256`]) {
    writeCurrent();
    rmSync(gone);
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /plan: not run: no canonical var file \(current\.tfvars with its \.sha256\)/);
  }
  writeCurrent();
  assert.equal(run().status, 0, 'back to current');
});

test('a wrong account and a missing stack.env stop the run, never pass it', () => {
  stackEnv();
  const wrong = run({ STUB_ACCOUNT: '210987654321' });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /wrong account/);
  const none = run({ PRIVATE_DIR: join(box, 'nowhere') });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no .*stack\.env/);
});

test('a Lambda bundle missing or older than its source makes the plan "not run" and names it; a current one lets the plan run', () => {
  stackEnv();
  const lambda = join(clone, 'infrastructure/lambda/demo');
  mkdirSync(join(lambda, 'src'), { recursive: true });
  writeFileSync(join(lambda, 'package.json'), '{"name":"demo","scripts":{"build":"tsup"}}');
  writeFileSync(join(lambda, 'src/index.ts'), 'export const handler = 1;\n');
  writeFileSync(join(clone, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  const at = (file, minutes) => { const t = new Date(Date.parse('2026-11-07T12:00:00Z') + minutes * 60_000); utimesSync(file, t, t); };
  for (const f of [join(lambda, 'package.json'), join(lambda, 'src/index.ts'), join(clone, 'pnpm-lock.yaml')]) at(f, 0);
  const notRun = /plan: not run: the demo Lambda is not built for this checkout \(plan\.sh builds it\)/;
  const missing = run({ STUB_PLAN_EXIT: '1' });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, notRun, 'no dist: the plan is not run (the stand-in would have failed it)');
  mkdirSync(join(lambda, 'dist'));
  assert.match(run({ STUB_PLAN_EXIT: '1' }).stdout, notRun, 'an empty dist');
  writeFileSync(join(lambda, 'dist/index.mjs'), 'built\n');
  at(join(lambda, 'dist/index.mjs'), 5);
  const built = run();
  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.match(built.stdout, /plan: no changes \(exit 0\)/, 'built after its source: the plan runs');
  for (const [file, what] of [[join(lambda, 'src/index.ts'), 'its source'], [join(clone, 'pnpm-lock.yaml'), 'the lockfile'], [join(lambda, 'package.json'), 'its package.json']]) {
    at(file, 10);
    const stale = run();
    assert.equal(stale.status, 1, what);
    assert.match(stale.stdout, notRun, `${what} changed after the build`);
    at(file, 0);
  }
  assert.equal(run().status, 0, 'back to current');
  rmSync(join(clone, 'infrastructure/lambda'), { recursive: true });
  rmSync(join(clone, 'pnpm-lock.yaml'));
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
