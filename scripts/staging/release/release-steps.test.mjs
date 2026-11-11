// Tests for scripts/staging/release/{image,migrate}.sh (spec 027, PR 3b). Imported by infrastructure/terraform/guard.test.mjs (`pnpm test:infra`).
// The scripts run for real against stand-ins: `aws`, `terraform`, `gh` and `docker` that answer from files and STUB_* variables and log their
// calls, a `run-task.sh` in the backend clone that plays `migrate status` and `migrate-up`, and a real git repository whose release commit is a
// merge (for CI's tree reuse). The real verify-image.mjs writes the break-glass record. What this cannot prove: that AWS, GitHub and Docker
// answer this way (the first release through these scripts is that check), or that the image builds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';

const here = new URL('.', import.meta.url).pathname;
const box = mkdtempSync(join(tmpdir(), 'release-steps-'));
after(() => rmSync(box, { recursive: true, force: true }));

const ACCOUNT = '111122223333';
const REPO_URL = `${ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api`;
const OLD = `${REPO_URL}@sha256:${'a'.repeat(64)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;
const NEW = `${REPO_URL}@${DIGEST}`;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const stubDir = join(box, 'stub');
mkdirSync(stubDir);
const bin = join(box, 'bin');
mkdirSync(bin);
const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "$*" >> "$STUB/${name}.log"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
// No Terraform runs on this machine as far as these scripts can tell; the check itself is tested in scripts/staging/terraform-running.test.mjs.
stub('pgrep', 'exit 1');
stub('aws', `case "$*" in
  *"--query Account"*) echo "${ACCOUNT}" ;;
  *"--query Arn"*) echo "arn:aws:sts::${ACCOUNT}:assumed-role/StagingRole/s" ;;
  *describe-services*"services[0].taskDefinition"*) echo "arn:aws:ecs:us-east-2:${ACCOUNT}:task-definition/telesphoros-staging-api:4" ;;
  *describe-services*) echo "\${STUB_SERVICE:-1 COMPLETED 1 1}" ;;
  *"describe-task-definition --task-definition telesphoros-staging-api-migrate "*) cat "$STUB/migrate_image" ;;
  *describe-task-definition*) echo "${OLD}" ;;
  *"ecr get-login-password"*) echo pw ;;
  *"describe-images"*imageTag*) [ -e "$STUB/pushed" ] && echo "${DIGEST}" || { echo "ImageNotFoundException" >&2; exit 254; } ;;
  *"describe-images"*imageDigest*) echo "application/vnd.oci.image.index.v1+json" ;;
  *batch-get-image*) echo '{"manifests":[{"digest":"sha256:${'d'.repeat(64)}","platform":{"os":"linux","architecture":"amd64"}},{"digest":"sha256:${'e'.repeat(64)}","platform":{"os":"unknown","architecture":"unknown"}}]}' ;;
  *describe-image-scan-findings*imageScanStatus*) echo "\${STUB_SCAN:-COMPLETE}" ;;
  *describe-image-scan-findings*findingSeverityCounts*) echo '{"HIGH": 1}' ;;
  *describe-image-scan-findings*) printf 'HIGH\\tpkg\\tCVE-0000-0001\\n' ;;
  *filter-log-events*GET*) [ -n "\${STUB_NO_GETS:-}" ] && echo '[]' || echo '["{\\"req\\":{\\"method\\":\\"GET\\"},\\"route\\":\\"/api/v1/health\\",\\"res\\":{\\"statusCode\\":200}}"]' ;;
  *filter-log-events*) [ -n "\${STUB_WRITES:-}" ] && echo '["{\\"req\\":{\\"method\\":\\"POST\\"},\\"route\\":\\"/api/v1/x\\",\\"res\\":{\\"statusCode\\":201}}"]' || echo '[]' ;;
  *"describe-db-snapshots --db-instance-identifier telesphoros-staging --snapshot-type manual "*) [ -n "\${STUB_LIST_FAIL:-}" ] && exit 254; cat "$STUB/manual_snaps" 2>/dev/null || true ;;
  *delete-db-snapshot*) [ -n "\${STUB_DELETE_FAIL:-}" ] && exit 254; echo deleting ;;
  *describe-db-snapshots*) [ -e "$STUB/snap" ] && echo "available 2026-11-06T00:00:00Z" || { echo "DBSnapshotNotFound" >&2; exit 254; } ;;
  *create-db-snapshot*) touch "$STUB/snap"; echo creating ;;
  *"rds wait"*) ;;
  *) echo "unexpected aws $*" >&2; exit 99 ;;
esac`);
stub('terraform', `case "$*" in
  version) echo "Terraform v1.16.5"; sleep 0.1; echo "on darwin_arm64" ;;
  *"output -raw api_repository_url"*) printf '%s' "${REPO_URL}" ;;
  *"output -raw api_cluster_name"*) printf telesphoros-staging-api ;;
  *"output -raw api_migrate_task_family"*) printf telesphoros-staging-api-migrate ;;
  *"output -raw api_provision_task_family"*) printf telesphoros-staging-api-provision ;;
  *"output -raw api_tasks_security_group_id"*) printf sg-1 ;;
  *"output -raw api_task_assign_public_ip"*) printf false ;;
  *"output -raw api_log_group"*) printf /ecs/telesphoros-staging-api ;;
  *"output -raw db_endpoint"*) printf 'telesphoros-staging.example.us-east-2.rds.amazonaws.com' ;;
  *"output -json api_task_subnet_ids"*) echo '["subnet-1","subnet-2"]' ;;
  *"state pull"*) cat "$STUB/state.json" ;;
  *) echo "unexpected terraform $*" >&2; exit 99 ;;
esac`);
stub('gh', `case "$*" in
  *"run list"*pull_request*) echo "\${STUB_PR_RUN-202}" ;;
  *"run list"*) echo "\${STUB_PUSH_RUN-101}" ;;
  *"run view 202 "*) echo "completed \${STUB_PR_IMAGE_JOB:-success}" ;;
  *"run view"*) echo "\${STUB_IMAGE_JOB:-success}" ;;
  *) echo "unexpected gh $*" >&2; exit 99 ;;
esac`);
stub('docker', `case "$*" in
  info|"buildx version") ;;
  login*) cat >/dev/null ;;
  "buildx build"*) ;;
  push*) touch "$STUB/pushed" ;;
  *) echo "unexpected docker $*" >&2; exit 99 ;;
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
put(clone, 'infrastructure/terraform/main.tf', '');
put(clone, 'infrastructure/docker/api.Dockerfile', 'FROM scratch\n');
put(clone, 'infrastructure/docker/rehearsal.cjs', 'process.exit(Number(process.env.STUB_REHEARSAL_EXIT || 0));\n');
put(clone, 'apps/backend/migrations/0070_b.up.sql', '');
put(clone, 'apps/backend/migrations/0071_c.up.sql', '');
put(clone, 'docs/ops/staging-expected.json', JSON.stringify({ newestMigration: '0070' }));
put(clone, 'scripts/staging/run-task.sh', `#!/usr/bin/env bash
echo "$*" >> "$STUB/run-task.log"
case "$1" in
  migrate-status) if [ -e "$STUB/migrated" ]; then printf 'applied: 0001\\tpending: %s\\n' "\${STUB_AFTER:-(none)}"; else printf 'applied: 0001\\tpending: %s\\n' "$(cat "$STUB/pending")"; fi ;;
  migrate-up) touch "$STUB/migrated"; exit "\${STUB_UP_EXIT:-0}" ;;
esac
`, 0o755);
git(clone, 'add', '.');
git(clone, 'commit', '-q', '-m', 'base');
git(clone, 'checkout', '-q', '-b', 'feature');
put(clone, 'apps/backend/src/x.ts', 'export {};\n');
git(clone, 'add', '.');
git(clone, 'commit', '-q', '-m', 'the change');
git(clone, 'checkout', '-q', 'main');
git(clone, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'feature');
const COMMIT = git(clone, 'rev-parse', 'HEAD');
git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
git(clone, 'remote', 'add', 'origin', 'https://github.com/example-org/example-repo.git');
const W = `${clone}-release-${COMMIT.slice(0, 8)}`;

const priv = join(box, 'private');
const staging = join(priv, 'staging');
const rel = join(priv, 'releases', COMMIT);
mkdirSync(join(staging, 'claim'), { recursive: true });
mkdirSync(join(priv, 'maindata'));
writeFileSync(join(staging, 'stack.env'), [`STAGING_ACCOUNT_ID=${ACCOUNT}`, `BACKEND_CLONE=${clone}`, `TERRAFORM=${join(bin, 'terraform')}`,
  `TF_DATA_DIR=${join(priv, 'maindata')}`].join('\n'));
writeFileSync(join(staging, 'claim/owner.json'), JSON.stringify({ owner: 'session-a', reason: 'release', started: '2026-11-06T00:00:00Z' }));
const current = join(staging, 'current.tfvars');
writeFileSync(current, `api_image = "${OLD}"\napi_migrate_image = "${OLD}"\n`);
writeFileSync(`${current}.sha256`, `${sha(current)}\n`);

const run = (script, args, env = {}) => spawnSync('bash', [join(here, script), ...args], {
  encoding: 'utf8',
  env: { PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: box, PRIVATE_DIR: priv, TMPDIR: box, STUB: stubDir,
    CLAIM_OWNER: 'session-a', SCAN_POLLS: '1', SCAN_WAIT: '0', ...env },
});
const log = (name) => (existsSync(join(stubDir, `${name}.log`)) ? readFileSync(join(stubDir, `${name}.log`), 'utf8') : '');
const clearLogs = () => { for (const n of ['aws', 'docker', 'gh', 'run-task']) rmSync(join(stubDir, `${n}.log`), { force: true }); };
const out = (r) => r.stdout + r.stderr;

test('image: the reason, the claim and CI come first; nothing is built before they pass', () => {
  assert.match(out(run('image.sh', [COMMIT])), /usage: image\.sh BUILD COMMIT/);
  assert.match(out(run('image.sh', ['BUILD', 'abc'])), /full 40-character commit id/);
  assert.match(out(run('image.sh', ['BUILD', COMMIT])), /no .*break-glass-reason\.txt/);
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, 'break-glass-reason.txt'), 'too short');
  assert.match(out(run('image.sh', ['BUILD', COMMIT])), /one line of 10 to 300 characters/);
  writeFileSync(join(rel, 'break-glass-reason.txt'), 'CI cannot sign in this account;\nfounder approved\n');
  assert.match(out(run('image.sh', ['BUILD', COMMIT])), /one line of 10 to 300 characters/, 'two lines are refused');
  writeFileSync(join(rel, 'break-glass-reason.txt'), 'CI cannot sign in this account; founder approved an unsigned synthetic staging image');
  assert.match(out(run('image.sh', ['BUILD', COMMIT], { CLAIM_OWNER: 'session-b' })), /held by someone else: session-a/);
  assert.match(out(run('image.sh', ['BUILD', COMMIT], { STUB_IMAGE_JOB: 'failure' })), /image job on .* is 'failure', not success/);
  assert.match(out(run('image.sh', ['BUILD', COMMIT], { STUB_IMAGE_JOB: 'skipped', STUB_PR_IMAGE_JOB: 'failure' })), /is 'completed failure', not success/);
  assert.match(out(run('image.sh', ['BUILD', COMMIT], { STUB_PUSH_RUN: '' })), /no push run of ci\.yml/);
  mkdirSync(join(rel, '.image.lock'));
  assert.match(out(run('image.sh', ['BUILD', COMMIT])), /another run of this step holds/);
  rmSync(join(rel, '.image.lock'), { recursive: true });
  // A merge whose tree is not its pull-request head's (main moved before the merge): the head's CI run proves nothing about it.
  git(clone, 'checkout', '-q', '-b', 'side', `${COMMIT}^1`);
  put(clone, 'apps/backend/src/y.ts', 'export {};\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'side change');
  git(clone, 'checkout', '-q', 'main');
  put(clone, 'apps/backend/src/z.ts', 'export {};\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'main moved');
  git(clone, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #2', 'side');
  const moved = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(join(priv, 'releases', moved), { recursive: true });
  writeFileSync(join(priv, 'releases', moved, 'break-glass-reason.txt'), readFileSync(join(rel, 'break-glass-reason.txt')));
  assert.match(out(run('image.sh', ['BUILD', moved], { STUB_IMAGE_JOB: 'skipped' })), /merge tree differs from the pull-request head tree: no reuse/);
  git(clone, 'reset', '-q', '--hard', COMMIT);
  git(clone, 'update-ref', 'refs/remotes/origin/main', COMMIT);
  assert.ok(!/buildx build|push/.test(log('docker')), 'nothing was built or pushed');
  assert.ok(!existsSync(join(rel, 'new_image.txt')));
});

test('image: a failed rehearsal pushes nothing; an unfinished scan writes no new_image.txt; a dirty build worktree is refused', () => {
  const failed = run('image.sh', ['BUILD', COMMIT], { STUB_REHEARSAL_EXIT: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout + failed.stderr, /synthetic rehearsal failed: not pushing/);
  assert.match(log('docker'), /buildx build --platform linux\/amd64/);
  assert.ok(!/^push/m.test(log('docker')), 'the image was not pushed');
  writeFileSync(join(W, 'stray.txt'), '');
  assert.match(out(run('image.sh', ['BUILD', COMMIT])), /build worktree is not clean/);
  rmSync(join(W, 'stray.txt'));
  const pending = run('image.sh', ['BUILD', COMMIT], { STUB_SCAN: 'IN_PROGRESS' });
  assert.equal(pending.status, 1);
  assert.match(out(pending), /scan is IN_PROGRESS, not COMPLETE/);
  assert.ok(existsSync(join(stubDir, 'pushed')), 'it was pushed this time');
  assert.ok(!existsSync(join(rel, 'new_image.txt')));
});

test('image: CI reused by tree, the tag reused from ECR, the break-glass record written, new_image.txt last; a second run refused', () => {
  clearLogs();
  const r = run('image.sh', ['BUILD', COMMIT], { STUB_IMAGE_JOB: 'skipped' });
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /tree reuse: pull-request head [0-9a-f]{8} \(same tree\), run 202, image job: completed success/);
  assert.match(r.stdout, /tag already in ECR: reusing it, no rebuild/);
  assert.ok(!/buildx build/.test(log('docker')));
  assert.match(log('aws'), new RegExp(`describe-image-scan-findings .*imageDigest=sha256:${'d'.repeat(64)}`), 'the scan read is of the amd64 manifest, not the index');
  assert.equal(readFileSync(join(rel, 'new_image.txt'), 'utf8').trim(), NEW);
  assert.equal(readFileSync(join(rel, 'old_image.txt'), 'utf8').trim(), OLD);
  const record = JSON.parse(readFileSync(join(rel, 'verified-image.json'), 'utf8'));
  assert.deepEqual([record.method, record.environment, record.images], ['break-glass', 'staging', [NEW]]);
  assert.match(record.reason, /founder approved an unsigned synthetic staging image/);
  assert.match(readFileSync(join(rel, 'scan.txt'), 'utf8'), /CVE-0000-0001/);
  assert.match(out(run('image.sh', ['BUILD', COMMIT])), /new_image\.txt exists: the image step already finished/);
});

const migrateReady = (pending) => {
  writeFileSync(join(stubDir, 'pending'), pending);
  writeFileSync(join(stubDir, 'migrate_image'), `${NEW}\n`);
  rmSync(join(stubDir, 'migrated'), { force: true });
  clearLogs();
};
// The manual snapshots the stand-in lists: [8-hex-letter, date, status?], as `--output text` prints them. Other names are listed too, so
// prune-snapshots.sh is shown to leave them alone.
const snapshots = (rows, extra = '') => writeFileSync(join(stubDir, 'manual_snaps'),
  rows.map(([h, d, st = 'available']) => `telesphoros-staging-pre-${h.repeat(8).slice(0, 8)}\t${st}\t${d}T08:00:00.000Z`).join('\n') + '\n' + extra);
const deleted = () => [...log('aws').matchAll(/delete-db-snapshot --db-snapshot-identifier (\S+)/g)].map((m) => m[1]);
// This release's IMAGE plan as plan.sh leaves it once the release check passed: the plan, its var file and its record (the real plan-record.mjs).
const STATE = { serial: 40, lineage: 'lineage-1' };
const imagePlanned = () => {
  writeFileSync(join(stubDir, 'state.json'), JSON.stringify({ version: 4, ...STATE, resources: [] }));
  writeFileSync(join(rel, 'i.tfplan'), 'a saved plan\n');
  writeFileSync(join(rel, 'release.tfvars'), `api_image = "${NEW}"\napi_migrate_image = "${NEW}"\n`);
  const w = spawnSync(process.execPath, [join(here, 'plan-record.mjs'), 'write', join(rel, 'i.tfplan.meta.json'), 'IMAGE', COMMIT,
    sha(join(rel, 'release.tfvars')), sha(join(rel, 'i.tfplan'))], { input: JSON.stringify(STATE), encoding: 'utf8' });
  assert.equal(w.status, 0, w.stderr);
};
const noChange = () => {
  assert.ok(!/create-db-snapshot/.test(log('aws')), 'no snapshot was taken');
  assert.ok(!/migrate-up/.test(log('run-task')), 'nothing was migrated');
  assert.ok(!existsSync(join(rel, 'migrate-status.txt')));
};

test('migrate: the MIGRATE apply, the migration task on NEW and steady services come first', () => {
  migrateReady('0071');
  assert.match(out(run('migrate.sh', [COMMIT])), /usage: migrate\.sh MIGRATE COMMIT/);
  assert.match(out(run('migrate.sh', ['MIGRATE', COMMIT])), /MIGRATE apply of this release did not finish/);
  writeFileSync(join(rel, 'm-apply.txt'), 'x\n== apply exit status: 0\n');
  imagePlanned();
  writeFileSync(join(stubDir, 'migrate_image'), `${OLD}\n`);
  assert.match(out(run('migrate.sh', ['MIGRATE', COMMIT])), /migrate task definition runs sha256:a{64}, not the NEW image/);
  writeFileSync(join(stubDir, 'migrate_image'), `${NEW}\n`);
  assert.match(out(run('migrate.sh', ['MIGRATE', COMMIT], { STUB_SERVICE: '2 IN_PROGRESS 1 1' })), /telesphoros-staging-api is not steady/);
  noChange();
});

test('migrate: the schema waits for this release IMAGE plan, recorded (so the release check passed it) and still matching the stack', () => {
  migrateReady('0071');
  const refused = (why, re) => {
    const r = run('migrate.sh', ['MIGRATE', COMMIT]);
    assert.equal(r.status, 1, why);
    assert.match(out(r), re, why);
    assert.ok(!/migrate-status/.test(log('run-task')), `${why}: not even migrate status ran`);
    noChange();
    imagePlanned();
  };
  for (const f of ['i.tfplan', 'i.tfplan.meta.json', 'release.tfvars']) {
    rmSync(join(rel, f));
    refused(`no ${f}`, /no recorded IMAGE plan for this release: run plan\.sh IMAGE/);
  }
  writeFileSync(join(rel, 'i.tfplan.meta.json'), 'not a record\n');
  refused('an unreadable record', /STALE: no record next to the plan[\s\S]*plan IMAGE again before migrating/);
  writeFileSync(join(stubDir, 'state.json'), JSON.stringify({ version: 4, serial: STATE.serial + 1, lineage: STATE.lineage, resources: [] }));
  refused('another apply since the plan', /STALE: serial: the plan was made at 40, now 41[\s\S]*plan IMAGE again before migrating/);
  writeFileSync(join(rel, 'i.tfplan'), 'a different plan\n');
  refused('the plan file replaced', /STALE: planSha256[\s\S]*plan IMAGE again/);
  writeFileSync(join(rel, 'release.tfvars'), 'api_image = "edited"\n');
  refused('the var file edited', /STALE: varSha256[\s\S]*plan IMAGE again/);
  const ok = run('migrate.sh', ['MIGRATE', COMMIT], { STUB_NO_GETS: '1' });
  assert.match(out(ok), /expected pending: 0071\nok\n/, 'with the recorded plan the gates pass (and the idle window stops it before any change)');
  noChange();
});

test('migrate: pending must be exactly what this release carries, and staging idle, before any snapshot or migration', () => {
  migrateReady('0070, 0071');
  const more = run('migrate.sh', ['MIGRATE', COMMIT]);
  assert.equal(more.status, 1);
  assert.match(out(more), /pending is 0070 0071, not exactly 0071[\s\S]*nothing migrated/);
  noChange();
  migrateReady('(none)');
  assert.match(out(run('migrate.sh', ['MIGRATE', COMMIT])), /pending is \(none\), not exactly 0071/, 'a stale facts file is not an interrupted run');
  noChange();
  migrateReady('0071');
  assert.match(out(run('migrate.sh', ['MIGRATE', COMMIT], { STUB_NO_GETS: '1' })), /idleness is unproven/);
  const busy = run('migrate.sh', ['MIGRATE', COMMIT], { STUB_WRITES: '1' });
  assert.match(out(busy), /staging is not idle/);
  assert.match(busy.stdout, /1 {2}POST \/api\/v1\/x 201/);
  noChange();
});

test('migrate: snapshot, migrate-up, then pending (none) recorded; a resumed run accepts what is left; nothing pending takes no snapshot', () => {
  migrateReady('0071');
  snapshots([['a', '2026-10-31'], ['b', '2026-11-01'], ['c', '2026-11-05'], ['d', '2026-11-08']]);
  const r = run('migrate.sh', ['MIGRATE', COMMIT]);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /== 6\. migrate status after[\s\S]*== 7\. Keep the newest 3 pre-migration snapshots[\s\S]*Deleted 1 older[\s\S]*Done/);
  assert.deepEqual(deleted(), ['telesphoros-staging-pre-aaaaaaaa'], 'only the oldest beyond three');
  assert.match(log('aws'), new RegExp(`create-db-snapshot --db-instance-identifier telesphoros-staging --db-snapshot-identifier telesphoros-staging-pre-${COMMIT.slice(0, 8)}`));
  assert.match(log('run-task'), /migrate-status --yes\nmigrate-up --yes\nmigrate-status --yes/);
  assert.equal(readFileSync(join(rel, 'migrate-status.txt'), 'utf8'), 'pending: (none)\n');
  assert.ok(existsSync(join(rel, 'migrate-up.started')));
  assert.match(out(run('migrate.sh', ['MIGRATE', COMMIT])), /migrate-status\.txt exists/);

  rmSync(join(rel, 'migrate-status.txt'));
  migrateReady('0071');
  const still = run('migrate.sh', ['MIGRATE', COMMIT], { STUB_AFTER: '0071' });
  assert.equal(still.status, 1);
  assert.match(out(still), /migrations still pending/);
  assert.ok(!existsSync(join(rel, 'migrate-status.txt')));

  migrateReady('(none)');
  const resumed = run('migrate.sh', ['MIGRATE', COMMIT]);
  assert.equal(resumed.status, 0, out(resumed));
  assert.match(resumed.stdout, /a migrate-up already started for this release[\s\S]*Nothing to migrate/);
  noChangeExceptStatus();

  rmSync(join(rel, 'migrate-status.txt'));
  rmSync(join(rel, 'migrate-up.started'));
  git(clone, 'checkout', '-q', '--detach');
  put(clone, 'docs/ops/staging-expected.json', JSON.stringify({ newestMigration: '0071' }));
  git(clone, 'commit', '-q', '-am', 'facts after the release');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(clone, 'checkout', '-q', 'main');
  migrateReady('(none)');
  const nothing = run('migrate.sh', ['MIGRATE', COMMIT]);
  assert.equal(nothing.status, 0, out(nothing));
  assert.match(nothing.stdout, /expected pending: \(none\)[\s\S]*Nothing to migrate/);
  noChangeExceptStatus();
});

function noChangeExceptStatus() {
  assert.ok(!/create-db-snapshot/.test(log('aws')), 'no snapshot was taken');
  assert.ok(!/migrate-up/.test(log('run-task')), 'nothing was migrated');
  assert.equal(readFileSync(join(rel, 'migrate-status.txt'), 'utf8'), 'pending: (none)\n');
}

test('prune-snapshots: keeps the newest 3 pre-migration snapshots, deletes only with --yes, and touches nothing else', () => {
  const prune = (args, env) => { clearLogs(); return run('prune-snapshots.sh', args, env); };
  assert.match(out(prune([])), /usage: prune-snapshots\.sh DB_IDENTIFIER/);
  assert.match(out(prune(['telesphoros-staging', '--force'])), /usage/);
  assert.match(out(prune(['Bad_Name'])), /usage/);
  assert.equal(log('aws'), '', 'nothing is asked of AWS before the arguments are right');

  // Out of order on purpose: the newest are chosen by time, not by listing order or name.
  const other = 'telesphoros-staging-before-upgrade\tavailable\t2026-01-01T00:00:00.000Z\ntelesphoros-staging-pre-12345678-copy\tavailable\t2026-01-02T00:00:00.000Z\n';
  snapshots([['e', '2026-11-10'], ['a', '2026-10-29'], ['c', '2026-11-05'], ['b', '2026-11-01'], ['d', '2026-11-08']], other);
  const dry = prune(['telesphoros-staging']);
  assert.equal(dry.status, 0, out(dry));
  assert.match(dry.stdout, /keep telesphoros-staging-pre-eeeeeeee[\s\S]*keep telesphoros-staging-pre-dddddddd[\s\S]*keep telesphoros-staging-pre-cccccccc[\s\S]*delete telesphoros-staging-pre-bbbbbbbb[\s\S]*delete telesphoros-staging-pre-aaaaaaaa[\s\S]*Dry run: nothing deleted/);
  assert.deepEqual(deleted(), [], 'a dry run deletes nothing');
  assert.ok(!/before-upgrade|12345678-copy/.test(dry.stdout), 'other manual snapshots are not even listed');

  const real = prune(['telesphoros-staging', '--yes']);
  assert.equal(real.status, 0, out(real));
  assert.deepEqual(deleted(), ['telesphoros-staging-pre-bbbbbbbb', 'telesphoros-staging-pre-aaaaaaaa']);
  assert.match(real.stdout, /Deleted 2 older pre-migration snapshot\(s\); kept the newest 3/);

  // Controls: three or fewer is left as it is; one still being created stops all deletion; a failed listing or delete stops with a reason.
  snapshots([['a', '2026-10-29'], ['b', '2026-11-01'], ['c', '2026-11-05']]);
  assert.match(prune(['telesphoros-staging', '--yes']).stdout, /Nothing to delete/);
  assert.deepEqual(deleted(), []);
  snapshots([['a', '2026-10-29'], ['b', '2026-11-01'], ['c', '2026-11-05'], ['d', '2026-11-08'], ['e', '2026-11-10', 'creating']]);
  const busy = prune(['telesphoros-staging', '--yes']);
  assert.equal(busy.status, 0, out(busy));
  assert.match(busy.stdout, /not available: telesphoros-staging-pre-eeeeeeee \(creating\)[\s\S]*nothing deleted/);
  assert.deepEqual(deleted(), [], 'nothing is deleted while a snapshot is being created');
  assert.match(out(prune(['telesphoros-staging', '--yes'], { STUB_LIST_FAIL: '1' })), /STOP: cannot list the snapshots/);
  snapshots([['a', '2026-10-29'], ['b', '2026-11-01'], ['c', '2026-11-05'], ['d', '2026-11-08']]);
  const failed = prune(['telesphoros-staging', '--yes'], { STUB_DELETE_FAIL: '1' });
  assert.equal(failed.status, 1);
  assert.match(out(failed), /STOP: delete-db-snapshot telesphoros-staging-pre-aaaaaaaa failed/);
  rmSync(join(stubDir, 'manual_snaps'), { force: true });
});

test('migrate: a failed prune is a warning after the migration, never a stopped release', () => {
  rmSync(join(rel, 'migrate-status.txt'), { force: true });
  rmSync(join(rel, 'migrate-up.started'), { force: true });
  // The facts on origin/main back to before this release, so 0071 is pending again (the test above moved them past it).
  git(clone, 'checkout', '-q', '--detach', 'refs/remotes/origin/main');
  put(clone, 'docs/ops/staging-expected.json', JSON.stringify({ newestMigration: '0070' }));
  git(clone, 'commit', '-q', '-am', 'facts before the release, again');
  git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(clone, 'checkout', '-q', 'main');
  migrateReady('0071');
  snapshots([['a', '2026-10-31'], ['b', '2026-11-01'], ['c', '2026-11-05'], ['d', '2026-11-08']]);
  const r = run('migrate.sh', ['MIGRATE', COMMIT], { STUB_DELETE_FAIL: '1' });
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /WARNING: pruning old snapshots failed[\s\S]*Done/);
  assert.equal(readFileSync(join(rel, 'migrate-status.txt'), 'utf8'), 'pending: (none)\n');
  rmSync(join(stubDir, 'manual_snaps'), { force: true });
});

test('the steps name no release: no commit, account, path, host or migration number is written into them', () => {
  for (const f of ['image.sh', 'migrate.sh', 'prune-snapshots.sh', 'migration-pending.mjs', 'lib.sh', 'verify.sh', 'frontend.sh', 'state-backup.sh']) {
    const text = readFileSync(join(here, f), 'utf8');
    for (const [what, re] of [['a commit', /\b[0-9a-f]{40}\b/], ['an account', /\b[0-9]{12}\b/], ['a home path', /\/Users\//], ['a host', /telesphoros\.app/],
      ['a migration number', /\b00[0-9]{2}\b/], ['BSD-only stat (CI runs GNU stat)', /\bstat -f\b/]]) assert.ok(!re.test(text), `${f} names ${what}`);
  }
});
