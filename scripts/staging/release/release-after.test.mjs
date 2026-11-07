// Tests for scripts/staging/release/{verify,frontend,state-backup}.sh (spec 027, PR 3b). Imported by infrastructure/terraform/guard.test.mjs.
// The scripts run for real against stand-ins: `aws`, `curl`, `terraform`, `pnpm` and `hdiutil` that answer from files and STUB_* variables,
// a publish-frontend.sh in the build worktree that records how it was called, and the real check-medication-fence-rollout.mjs judging an
// observation built in the shape of its own fixtures. What this cannot prove: that AWS, CloudFront and hdiutil answer this way (the first
// release through these scripts is that check), or that the frontend builds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';

const here = new URL('.', import.meta.url).pathname;
const box = mkdtempSync(join(tmpdir(), 'release-after-'));
after(() => rmSync(box, { recursive: true, force: true }));

const ACCOUNT = '111122223333';
const PREFIX = `arn:aws:ecs:us-east-2:${ACCOUNT}:`;
const REPO_URL = `${ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api`;
const OLD = `${REPO_URL}@sha256:${'a'.repeat(64)}`;
const NEW = `${REPO_URL}@sha256:${'c'.repeat(64)}`;
const TD = `${PREFIX}task-definition/telesphoros-staging-api:12`;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const stubDir = join(box, 'stub');
mkdirSync(stubDir);
const bin = join(box, 'bin');
mkdirSync(bin);
const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "$*" >> "$STUB/${name}.log"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
stub('aws', `case "$*" in
  *"--query Account"*) echo "${ACCOUNT}" ;;
  *describe-services*"services[0].taskDefinition"*) echo "${TD}" ;;
  *describe-services*"--output json"*) cat "$STUB/services.json" ;;
  *describe-services*) echo "svc \${STUB_SERVICE:-1 COMPLETED 2 2}" ;;
  *list-tasks*RUNNING*"--output json"*) cat "$STUB/running.json" ;;
  *list-tasks*STOPPED*) cat "$STUB/stopped.json" ;;
  *list-tasks*) echo "${PREFIX}task/telesphoros-staging-api/1" ;;
  *describe-tasks*"--output json"*) cat "$STUB/tasks.json" ;;
  *describe-tasks*) echo "\${STUB_TASK_TD:-${TD}}" ;;
  *describe-task-definition*"--output json"*) cat "$STUB/taskdef.json" ;;
  *"describe-task-definition --task-definition ${PREFIX}task-definition/telesphoros-staging-api:11 "*) echo "${OLD}" ;;
  *describe-task-definition*) echo "${NEW}" ;;
  *describe-alarms*"--state-value ALARM"*) echo "\${STUB_INALARM-}" ;;
  *describe-alarms*) echo 36 ;;
  *filter-log-events*) [ -n "\${STUB_NO_LEDGER:-}" ] && echo '[]' || echo '["{\\"event\\":\\"ledger-full-check-completed\\",\\"tenantsChecked\\":1}"]' ;;
  *) echo "unexpected aws $*" >&2; exit 99 ;;
esac`);
stub('curl', `case "$*" in
  *"/api/v1/"*) printf '%s' "\${STUB_HTTP:-200}" ;;
  *) echo '<script type="module" src="/assets/index-Ab12_c.js"></script>' ;;
esac`);
stub('terraform', `case "$*" in
  version) echo "Terraform v1.16.5"; sleep 0.1; echo "on darwin_arm64" ;;
  *"output -raw api_cluster_name"*) printf telesphoros-staging-api ;;
  *"output -raw api_log_group"*) printf /ecs/telesphoros-staging-api ;;
  *"output -raw web_bucket"*) printf telesphoros-staging-web ;;
  *"output -raw cognito_issuer"*) printf https://cognito-idp.us-east-2.amazonaws.com/us-east-2_example ;;
  *"output -raw cognito_app_client_id"*) printf exampleclientid ;;
  *"output -raw cognito_sign_in_domain"*) printf https://auth.example.test ;;
  *"output -raw web_distribution_id"*) printf E1EXAMPLE ;;
  *"state show"*) printf '  arn  = "${TD}"\\n  family = "telesphoros-staging-api"\\n' ;;
  *"state list"*) cat "$STUB/state-list" ;;
  *"state pull"*) n=$(cat "$STUB/pulls" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUB/pulls"; if [ "$n" -ge 1 ] && [ -e "$STUB/state-later" ]; then cat "$STUB/state-later"; else cat "$STUB/state"; fi ;;
  *) echo "unexpected terraform $*" >&2; exit 99 ;;
esac`);
stub('pnpm', `case "$*" in --version) echo "\${STUB_PNPM:-10.28.0}" ;; install*) ;; *) exit 99 ;; esac`);
// hdiutil: an image's files live beside it in IMAGE.content; attach copies them to the mount point, detach moves them back and empties it.
stub('hdiutil', `case "$1" in
  create) for a in "$@"; do last="$a"; done; echo "encrypted image" > "$last"; rm -rf "$last.content"; mkdir "$last.content" ;;
  attach) img="$2"; mnt=""; prev=""; for a in "$@"; do [ "$prev" = -mountpoint ] && mnt="$a"; prev="$a"; done
    cp -R "$img.content/." "$mnt/"; echo "$img" > "$STUB/attached" ;;
  detach) img=$(cat "$STUB/attached"); rm -rf "$img.content"; mkdir "$img.content"; cp -R "$2/." "$img.content/"; rm -rf "\${2:?}"/* ;;
  isencrypted) echo "encrypted: YES" ;;
esac`);

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const put = (root, path, text, mode) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); if (mode) chmodSync(join(root, path), mode); };
const clone = join(box, 'telesphoros');
mkdirSync(clone);
git(clone, 'init', '-q', '-b', 'main');
put(clone, '.nvmrc', `${process.version.slice(1)}\n`);
put(clone, 'package.json', JSON.stringify({ packageManager: 'pnpm@10.28.0' }));
put(clone, 'infrastructure/terraform/main.tf', '');
put(clone, 'docs/ops/staging-expected.json', JSON.stringify({ alarms: 36, newestMigration: '0070' }));
put(clone, 'scripts/staging/publish-frontend.sh', '#!/usr/bin/env bash\necho "publish-frontend $* api=$VITE_API_BASE_URL bucket=$WEB_BUCKET" >> "$STUB/publish.log"\nexit "${STUB_PUBLISH_EXIT:-0}"\n', 0o755);
git(clone, 'add', '.');
git(clone, 'commit', '-q', '-m', 'release');
const COMMIT = git(clone, 'rev-parse', 'HEAD');
git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
const W = `${clone}-release-${COMMIT.slice(0, 8)}`;
git(clone, 'worktree', 'add', '-q', '--detach', W, COMMIT);

const priv = join(box, 'private');
const staging = join(priv, 'staging');
const rel = join(priv, 'releases', COMMIT);
mkdirSync(join(staging, 'claim'), { recursive: true });
mkdirSync(rel, { recursive: true });
mkdirSync(join(priv, 'maindata'));
const stackEnv = (extra = []) => writeFileSync(join(staging, 'stack.env'), [`STAGING_ACCOUNT_ID=${ACCOUNT}`, `BACKEND_CLONE=${clone}`,
  `TERRAFORM=${join(bin, 'terraform')}`, `TF_DATA_DIR=${join(priv, 'maindata')}`, 'API_BASE_URL=https://api.example.test', 'APP_URL=https://app.example.test', ...extra].join('\n'));
stackEnv();
writeFileSync(join(staging, 'claim/owner.json'), JSON.stringify({ owner: 'session-a', reason: 'release', started: '2026-11-06T00:00:00Z' }));
const current = join(staging, 'current.tfvars');
const BASE = `api_image = "${NEW}"\napi_migrate_image = "${NEW}"\n`;
const setCurrent = (text, copyTo) => {
  writeFileSync(current, text);
  writeFileSync(`${current}.sha256`, `${sha(current)}\n`);
  if (copyTo) writeFileSync(copyTo, text);
};
const ON = `${BASE}synthetic_assessment_enabled = true\n`;
const OFF = `${BASE}synthetic_assessment_enabled = false\n`;
setCurrent(ON, join(rel, 'release.tfvars'));
writeFileSync(join(rel, 'new_image.txt'), `${NEW}\n`);
writeFileSync(join(rel, 'i-apply.txt'), '== apply exit status: 0\n');
writeFileSync(join(rel, 'i.tfplan'), 'plan');

// The observation, in the shape of check-medication-fence-rollout.test.mjs's own snapshot, on NEW.
const CLUSTER = `${PREFIX}cluster/telesphoros-staging-api`;
const SERVICE = `${PREFIX}service/telesphoros-staging-api/telesphoros-staging-api`;
const taskArn = (n) => `${PREFIX}task/telesphoros-staging-api/${String(n).padStart(32, '0')}`;
const SETTINGS = [{ name: 'SYNTHETIC_ASSESSMENT', value: 'enabled' }, { name: 'SYNTHETIC_KNOWLEDGE_DIR', value: '/app/synthetic-knowledge' }];
const observe = ({ writes = 'disabled', assessment = true } = {}) => {
  const j = (n, v) => writeFileSync(join(stubDir, n), JSON.stringify(v));
  j('services.json', { failures: [], services: [{ serviceArn: SERVICE, clusterArn: CLUSTER, serviceName: 'telesphoros-staging-api', status: 'ACTIVE',
    taskDefinition: TD, desiredCount: 2, runningCount: 2, pendingCount: 0,
    deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: TD, desiredCount: 2, runningCount: 2, pendingCount: 0 }] }] });
  j('running.json', { taskArns: [taskArn(1), taskArn(2)] });
  j('stopped.json', { taskArns: [] });
  j('tasks.json', { failures: [], tasks: [1, 2].map((n) => ({ taskArn: taskArn(n), clusterArn: CLUSTER, group: 'service:telesphoros-staging-api',
    taskDefinitionArn: TD, lastStatus: 'RUNNING', desiredStatus: 'RUNNING', healthStatus: 'HEALTHY',
    containers: [{ name: 'api', image: NEW, imageDigest: `sha256:${'c'.repeat(64)}`, lastStatus: 'RUNNING', healthStatus: 'HEALTHY' }],
    overrides: { containerOverrides: [{ name: 'api' }] } })) });
  j('taskdef.json', { taskDefinition: { taskDefinitionArn: TD, status: 'ACTIVE', containerDefinitions: [{ name: 'api', image: NEW,
    environment: [{ name: 'MEDICATION_WRITES', value: writes }, ...(assessment ? SETTINGS : [])], secrets: [], environmentFiles: [] }] } });
};
observe();

const run = (script, args, env = {}) => spawnSync('bash', [join(here, script), ...args], {
  encoding: 'utf8',
  env: { PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: box, PRIVATE_DIR: priv, TMPDIR: box, STUB: stubDir,
    CLAIM_OWNER: 'session-a', PUBLISH_SETTLE: '0', ...env },
});
const out = (r) => r.stdout + r.stderr;
const ok = join(rel, 'verify-ok.txt');

test('verify: what it follows comes first, and an open fence is never verified', () => {
  assert.match(out(run('verify.sh', ['IMAGE'])), /full 40-character commit id/);
  assert.match(out(run('verify.sh', ['FENCE-OPEN', COMMIT, 'open-1'])), /checks a closed medication fence only/);
  assert.match(out(run('verify.sh', ['ASSESSMENT-ON', COMMIT, '../x'])), /operation id must be/);
  stackEnv(['API_BASE_URL=http://api.example.test']);
  assert.match(out(run('verify.sh', ['IMAGE', COMMIT])), /API_BASE_URL in stack\.env is not https/);
  stackEnv();
  writeFileSync(join(rel, 'i-apply.txt'), '== apply exit status: 1\n');
  assert.match(out(run('verify.sh', ['IMAGE', COMMIT])), /IMAGE apply has not finished with exit 0/);
  writeFileSync(join(rel, 'i-apply.txt'), '== apply exit status: 0\n');
  setCurrent(OFF);
  assert.match(out(run('verify.sh', ['IMAGE', COMMIT])), /current\.tfvars is not this apply's var file/);
  setCurrent(`${ON}medication_writes_enabled = true\n`, join(rel, 'release.tfvars'));
  assert.match(out(run('verify.sh', ['IMAGE', COMMIT])), /opens medication writes/);
  setCurrent(ON, join(rel, 'release.tfvars'));
  assert.ok(!existsSync(ok));
});

test('verify: each failed check fails the run and writes nothing', () => {
  for (const [env, shows, change] of [
    [{ STUB_HTTP: '503' }, /\/api\/v1\/ready returned 503/],
    [{ STUB_INALARM: 'telesphoros-staging-api-5xx' }, /in ALARM: telesphoros-staging-api-5xx/],
    [{ STUB_NO_LEDGER: '1' }, /no ledger-full-check-completed line/],
    [{ STUB_SERVICE: '2 IN_PROGRESS 1 2' }, /telesphoros-staging-api is not steady/],
    [{ STUB_TASK_TD: `${PREFIX}task-definition/telesphoros-staging-api:11` }, /runs sha256:a{64}, not sha256:c{64}/],
    [{}, /fence checker holds/, () => observe({ writes: 'enabled' })],
    [{}, /SYNTHETIC_ASSESSMENT is not exactly enabled/, () => observe({ assessment: false })],
  ]) {
    if (change) change();
    const r = run('verify.sh', ['IMAGE', COMMIT], env);
    assert.equal(r.status, 1, JSON.stringify(env) + out(r));
    assert.match(out(r), shows);
    assert.match(r.stdout, /SOME CHECKS FAILED/);
    assert.ok(!existsSync(ok));
    observe();
  }
});

test('verify: IMAGE passes and records the current.tfvars it verified; ASSESSMENT-OFF expects the settings gone', () => {
  const r = run('verify.sh', ['IMAGE', COMMIT]);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /checker: \{"status":"observed-disabled"/);
  assert.match(r.stdout, /alarms: 36 \(staging-expected\.json on origin\/main: 36\)/);
  const text = readFileSync(ok, 'utf8');
  assert.match(text, new RegExp(`^current ${sha(current)}$`, 'm'));
  assert.match(text, /^assessment present$/m);
  const op = join(rel, 'assessments/off-1');
  mkdirSync(op, { recursive: true });
  setCurrent(OFF, join(op, 'ad.tfvars'));
  writeFileSync(join(op, 'ad.tfplan'), 'plan');
  writeFileSync(join(op, 'ad-apply.txt'), '== apply exit status: 0\n');
  const still = run('verify.sh', ['ASSESSMENT-OFF', COMMIT, 'off-1']);
  assert.equal(still.status, 1);
  assert.match(out(still), /SYNTHETIC_ASSESSMENT is set, but current\.tfvars switches the assessment off/);
  observe({ assessment: false });
  const off = run('verify.sh', ['ASSESSMENT-OFF', COMMIT, 'off-1']);
  assert.equal(off.status, 0, out(off));
  assert.match(readFileSync(join(op, 'verify-ok.txt'), 'utf8'), /^assessment absent$/m);
  assert.match(out(run('verify.sh', ['IMAGE', COMMIT])), /a later apply changed it; verify that one/, 'the IMAGE apply is no longer what runs');
});

test('frontend: publishes only what verify.sh passed for the current.tfvars that runs now, DRY first', () => {
  assert.match(out(run('frontend.sh', ['PUBLISH', COMMIT])), /no publish-dry\.ok: run DRY first/);
  setCurrent(ON);
  assert.match(out(run('frontend.sh', ['DRY', COMMIT])), /no verify-ok\.txt for the current\.tfvars that runs now/, 'the ON verification was for a file that has since changed');
  setCurrent(OFF);
  writeFileSync(join(rel, 'assessments/off-1/ad-apply.txt'), '== apply exit status: 0\n');
  assert.match(out(run('frontend.sh', ['DRY', COMMIT])), /newer than the last apply/, 'an apply after the verification');
  assert.equal(run('verify.sh', ['ASSESSMENT-OFF', COMMIT, 'off-1']).status, 0);
  stackEnv(['APP_URL=']);
  assert.match(out(run('frontend.sh', ['DRY', COMMIT])), /APP_URL in stack\.env is not https/);
  stackEnv();
  assert.match(out(run('frontend.sh', ['DRY', COMMIT], { STUB_PNPM: '9.0.0' })), /pnpm is not 10\.28\.0/);
  assert.match(out(run('frontend.sh', ['DRY', COMMIT], { STUB_HTTP: '503' })), /the API is not ready \(503\)/);
  assert.match(out(run('frontend.sh', ['DRY', COMMIT], { STUB_PUBLISH_EXIT: '1' })), /the dry run refused/);
  assert.ok(!existsSync(join(rel, 'publish-dry.ok')), 'a refused DRY run leaves nothing for PUBLISH');
  rmSync(join(stubDir, 'publish.log'), { force: true });
  const dry = run('frontend.sh', ['DRY', COMMIT]);
  assert.equal(dry.status, 0, out(dry));
  assert.match(dry.stdout, /verified: releases\/[0-9a-f]{40}\/assessments\/off-1\/verify-ok\.txt; the synthetic assessment is off/);
  assert.equal(readFileSync(join(stubDir, 'publish.log'), 'utf8'), 'publish-frontend  api=https://api.example.test bucket=telesphoros-staging-web\n', 'no assessment flag while it is off');
  writeFileSync(join(W, 'stray.txt'), '');
  assert.match(out(run('frontend.sh', ['PUBLISH', COMMIT])), /build worktree is not clean/);
  rmSync(join(W, 'stray.txt'));
  const published = run('frontend.sh', ['PUBLISH', COMMIT]);
  assert.equal(published.status, 0, out(published));
  assert.match(readFileSync(join(stubDir, 'publish.log'), 'utf8'), /^publish-frontend --yes api=/m);
  assert.match(readFileSync(join(rel, 'publish.txt'), 'utf8'), /live index after: assets\/index-Ab12_c\.js[\s\S]*PUBLISHED/);
  assert.match(out(run('frontend.sh', ['PUBLISH', COMMIT])), /publish\.txt exists: this frontend was already published/);
});

test('frontend: the assessment flag follows current.tfvars, and PUBLISH refuses a DRY run made against another current.tfvars', () => {
  rmSync(join(rel, 'publish.txt'));
  const op = join(rel, 'assessments/on-2');
  mkdirSync(op, { recursive: true });
  setCurrent(ON, join(op, 'ae.tfvars'));
  writeFileSync(join(op, 'ae.tfplan'), 'plan');
  writeFileSync(join(op, 'ae-apply.txt'), '== apply exit status: 0\n');
  assert.match(out(run('frontend.sh', ['PUBLISH', COMMIT])), /no verify-ok\.txt for the current\.tfvars/);
  observe();
  assert.equal(run('verify.sh', ['ASSESSMENT-ON', COMMIT, 'on-2']).status, 0);
  assert.match(out(run('frontend.sh', ['PUBLISH', COMMIT])), /the DRY run was made against another current\.tfvars: run DRY again/);
  rmSync(join(stubDir, 'publish.log'), { force: true });
  const dry = run('frontend.sh', ['DRY', COMMIT]);
  assert.equal(dry.status, 0, out(dry));
  assert.match(readFileSync(join(stubDir, 'publish.log'), 'utf8'), /^publish-frontend --with-synthetic-assessment api=/);
  assert.match(out(run('frontend.sh', ['DRY', COMMIT], { STUB_PUBLISH_EXIT: '1' })), /the dry run refused/);
  assert.match(out(run('frontend.sh', ['PUBLISH', COMMIT])), /no publish-dry\.ok: run DRY first/, 'a refused DRY run voids the one before it');
});

const STATE = (serial, extra = '') => JSON.stringify({ version: 4, serial, lineage: 'lineage-1', outputs: { db: { value: 'SENTINEL-SECRET' } }, resources: [{ a: 1 }, { b: 2 }], extra });
const backupReady = () => {
  writeFileSync(join(rel, 'm-apply.txt'), '== apply exit status: 0\n');
  writeFileSync(join(rel, 'i.tfplan.meta.json'), JSON.stringify({ serial: 42 }));
  writeFileSync(join(rel, 'i.plan.json'), JSON.stringify({ prior_state: { values: { root_module: { resources: [{}, {}, {}], child_modules: [{ resources: [{}] }] } } },
    resource_changes: [{ change: { actions: ['create'] } }, { change: { actions: ['delete', 'create'] } }, { change: { actions: ['update'] } }] }));
  writeFileSync(join(stubDir, 'state-list'), 'a\nb\nc\nd\ne\n');
  writeFileSync(join(stubDir, 'state'), STATE(47));
  rmSync(join(stubDir, 'state-later'), { force: true });
  rmSync(join(stubDir, 'pulls'), { force: true });
};
const dmg = () => join(priv, `tfstate-backup-${new Date().toLocaleDateString('en-CA')}-${COMMIT.slice(0, 8)}.dmg`);

test('state backup: the release finished, the count holds, a newer serial and the same live content, or it stops', () => {
  backupReady();
  assert.match(out(run('state-backup.sh', [COMMIT])), /usage: state-backup\.sh BACKUP COMMIT/);
  rmSync(join(rel, 'm-apply.txt'));
  assert.match(out(run('state-backup.sh', ['BACKUP', COMMIT])), /MIGRATE and IMAGE apply logs of this release are missing/);
  backupReady();
  writeFileSync(join(rel, 'i.tfplan.meta.json'), '{}');
  assert.match(out(run('state-backup.sh', ['BACKUP', COMMIT])), /no state serial in the IMAGE plan's record/);
  backupReady();
  writeFileSync(join(stubDir, 'state-list'), 'a\nb\nc\nd\n');
  assert.match(out(run('state-backup.sh', ['BACKUP', COMMIT])), /expected 5 addresses, found 4: the state moved/);
  backupReady();
  writeFileSync(join(stubDir, 'state'), STATE(42));
  assert.match(out(run('state-backup.sh', ['BACKUP', COMMIT])), /serial 42 is not newer than the 42 recorded with the IMAGE plan/);
  rmSync(dmg(), { force: true });
  backupReady();
  writeFileSync(join(stubDir, 'state-later'), STATE(47, 'changed'));
  assert.match(out(run('state-backup.sh', ['BACKUP', COMMIT])), /same serial, but the content differs/);
  rmSync(dmg(), { force: true });
  mkdirSync(join(priv, '.state-backup.lock'));
  assert.match(out(run('state-backup.sh', ['BACKUP', COMMIT])), /another run of this script holds/);
  rmSync(join(priv, '.state-backup.lock'), { recursive: true });
});

test('state backup: writes the image, prints counts and hashes but never the state; a second run the same day is refused', () => {
  backupReady();
  const r = run('state-backup.sh', ['BACKUP', COMMIT]);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /live: 5 addresses; expected from the IMAGE plan: 5/);
  assert.match(r.stdout, /written: serial 47, lineage lineage-.*re-open ok[\s\S]*encrypted: YES/s);
  assert.ok(existsSync(dmg()));
  assert.ok(!out(r).includes('SENTINEL'), 'the state is never printed');
  assert.ok(!existsSync(join(priv, `mnt-tfstate-${new Date().toLocaleDateString('en-CA')}-${COMMIT.slice(0, 8)}`)), 'the mount point is gone');
  assert.match(out(run('state-backup.sh', ['BACKUP', COMMIT])), /already exists/);
});
