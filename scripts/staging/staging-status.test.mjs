// Tests for scripts/staging/staging-status.mjs (spec 027, PR 2). Imported by infrastructure/terraform/guard.test.mjs, so `pnpm test:infra` runs it.
// The module is pure: it compares docs/ops/staging-expected.json with what staging-status.sh observed, and reduces Terraform's state and plan
// output to identifiers. What this cannot prove: that AWS answers the shell's queries the way the fixtures do.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collect, compare, planSummary, report, stateIdentity } from './staging-status.mjs';

const root = new URL('../../', import.meta.url).pathname;
const cli = join(root, 'scripts/staging/staging-status.mjs');
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });

const DIGEST = `sha256:${'d5'.repeat(32)}`;
const FACTS = {
  checked: '2026-10-31',
  appliedCommit: 'a'.repeat(40),
  image: { digest: DIGEST, commit: 'b'.repeat(40) },
  taskDefinitions: { api: 4, worker: 3 },
  alarms: 31,
  newestMigration: '0064',
  cloudfrontCachePaths: ['/assets/*'],
  acceptedExceptions: [{ id: 'break-glass-x', reason: 'r', reviewBy: '2026-11-30' }],
};
const OBSERVED = {
  api: { revision: 4, digest: DIGEST },
  worker: { revision: 3, digest: DIGEST },
  alarms: 31,
  cloudfrontCachePaths: ['/assets/*'],
  newestMigration: '0064',
  ready: 200,
};
const QUIET = { plan: { exit: 0, changes: [] }, unapplied: [], savedPlans: [], legacyPlans: 0, claim: null, serial: 42, now: '2026-10-31T19:00:00Z' };

test('every field agrees: every row is ok (positive control)', () => {
  const rows = compare(FACTS, OBSERVED);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.filter((r) => r.status !== 'ok'), []);
  assert.equal(report({ rows, ...QUIET }).exitCode, 0);
});

test('each field that moves is DRIFT, and only that one', () => {
  const moves = {
    'api.revision': (o) => { o.api.revision = 5; }, 'worker.revision': (o) => { o.worker.revision = 4; },
    'api.digest': (o) => { o.api.digest = `sha256:${'0'.repeat(64)}`; }, 'worker.digest': (o) => { o.worker.digest = `sha256:${'0'.repeat(64)}`; },
    alarms: (o) => { o.alarms = 33; }, cloudfrontCachePaths: (o) => { o.cloudfrontCachePaths = []; },
    newestMigration: (o) => { o.newestMigration = '0065'; }, ready: (o) => { o.ready = 503; },
  };
  for (const [field, move] of Object.entries(moves)) {
    const o = structuredClone(OBSERVED);
    move(o);
    const bad = compare(FACTS, o).filter((r) => r.status !== 'ok');
    assert.deepEqual(bad.map((r) => [r.field, r.status]), [[field, 'DRIFT']], field);
    assert.equal(report({ rows: compare(FACTS, o), ...QUIET }).exitCode, 1, field);
  }
});

test('a read that was refused or missing is unknown, never ok, and fails the run', () => {
  for (const o of [{ ...OBSERVED, alarms: { refused: 'AccessDenied' } }, { ...OBSERVED, api: undefined }, {}]) {
    const rows = compare(FACTS, o);
    assert.ok(rows.some((r) => r.status === 'unknown'));
    assert.ok(!rows.some((r) => r.status === 'ok' && r.live === undefined));
    assert.equal(report({ rows, ...QUIET }).exitCode, 1);
  }
});

test('the plan, unapplied Terraform, saved plans and the claim each fail the run when they have something to say', () => {
  const rows = compare(FACTS, OBSERVED);
  const cases = {
    'plan has changes': { plan: { exit: 2, changes: ['update aws_cloudfront_distribution.web[0]'] } },
    'plan failed': { plan: { exit: 1, changes: [] } },
    'plan not run': { plan: { exit: null, changes: [], why: 'no var file' } },
    'merged and not applied': { unapplied: ['61f472dd Merge pull request #210'] },
    'a stale saved plan': { savedPlans: [{ path: 'releases/x/i.tfplan', serial: 41 }] },
    'a saved plan with no record': { savedPlans: [{ path: 'releases/x/m.tfplan', serial: null }] },
    'an abandoned claim': { claim: { owner: 'session-a', reason: 'release', started: '2026-10-30T12:00:00Z' } },
  };
  for (const [name, extra] of Object.entries(cases)) {
    const r = report({ rows, ...QUIET, ...extra });
    assert.equal(r.exitCode, 1, name);
  }
  const current = report({ rows, ...QUIET, savedPlans: [{ path: 'releases/x/i.tfplan', serial: 42 }], legacyPlans: 12 });
  assert.equal(current.exitCode, 0, 'a plan made at the current serial, and legacy plans that are only counted, do not fail');
  assert.match(current.text, /12 saved plans from before spec 027/);
  const held = report({ rows, ...QUIET, claim: { owner: 'session-a', reason: 'release', started: '2026-10-31T18:00:00Z' } });
  assert.equal(held.exitCode, 0, 'a claim held for an hour is reported, not a failure');
  assert.match(held.text, /claim: held by session-a/);
});

test('the state projection keeps the serial and lineage and nothing else', () => {
  const state = JSON.stringify({ version: 4, serial: 42, lineage: 'l-1', outputs: { db_password: { value: 'SENTINEL-VALUE' } }, resources: [{ instances: [{ attributes: { secret: 'SENTINEL-VALUE' } }] }] });
  assert.deepEqual(stateIdentity(state), { serial: 42, lineage: 'l-1' });
  const out = run(['project-state'], state);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { serial: 42, lineage: 'l-1' });
  assert.ok(!out.stdout.includes('SENTINEL') && !out.stderr.includes('SENTINEL'));
  for (const bad of ['', 'not json', JSON.stringify({ serial: '42', lineage: 'l' }), JSON.stringify({ serial: 1 })]) {
    const r = run(['project-state'], bad);
    assert.notEqual(r.status, 0, bad);
    assert.ok(!r.stderr.includes('SENTINEL'));
  }
});

test('the plan projection keeps addresses and actions only, and drops no-ops and reads', () => {
  const plan = {
    resource_changes: [
      { address: 'aws_cloudfront_distribution.web[0]', change: { actions: ['update'], before: { x: 'SENTINEL-VALUE' }, after: { x: 'SENTINEL-VALUE-2' } } },
      { address: 'aws_ecs_task_definition.api[0]', change: { actions: ['delete', 'create'], after: { container_definitions: 'SENTINEL-VALUE' } } },
      { address: 'aws_s3_bucket.reports', change: { actions: ['no-op'] } },
      { address: 'data.aws_caller_identity.current', change: { actions: ['read'] } },
    ],
    variables: { api_image: { value: 'SENTINEL-VALUE' } },
  };
  assert.deepEqual(planSummary(plan), ['delete,create aws_ecs_task_definition.api[0]', 'update aws_cloudfront_distribution.web[0]']);
  const out = run(['project-plan'], JSON.stringify(plan));
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!out.stdout.includes('SENTINEL'));
  assert.equal(run(['project-plan'], 'not json').status === 0, false);
});

test('collect turns the shell work directory into what report takes; a refusal is unknown, not empty', () => {
  const files = {
    '/w/api-revision': '4', '/w/api-digest': DIGEST, '/w/worker-revision': '3', '/w/worker-digest': DIGEST, '/w/alarms.out': '31',
    '/w/paths.out': '/assets/*', '/w/migration': '0064', '/w/state.json': '{"serial":42,"lineage":"l"}', '/w/changes': '', '/w/unapplied': '',
    '/w/saved': '/p/releases/x/i.tfplan', '/p/releases/x/i.tfplan.meta.json': '{"serial":42}',
  };
  const io = (f) => ({ exists: (n) => n in f, read: (n) => { if (!(n in f)) throw new Error('ENOENT'); return f[n]; }, now: QUIET.now });
  const env = { READY: '200', PLAN_EXIT: '0', PLAN_WHY: '', LEGACY: '12', CLAIM: '/p/staging/claim/owner.json', PRIVATE: '/p' };
  const o = collect('/w', env, io(files));
  assert.deepEqual(compare(FACTS, o).filter((r) => r.status !== 'ok'), []);
  assert.deepEqual([o.serial, o.legacyPlans, o.savedPlans, o.claim], [42, 12, [{ path: 'releases/x/i.tfplan', serial: 42 }], null]);
  assert.equal(report({ ...o, rows: compare(FACTS, o) }).exitCode, 0);
  const refusedAlarms = collect('/w', env, io({ ...files, '/w/alarms.refused': 'AccessDenied' }));
  assert.deepEqual(refusedAlarms.alarms, { refused: 'AccessDenied' });
  assert.equal(compare(FACTS, refusedAlarms).find((r) => r.field === 'alarms').status, 'unknown');
  const emptyRefusal = collect('/w', env, io({ ...files, '/w/dists.refused': '' }));
  assert.equal(compare(FACTS, emptyRefusal).find((r) => r.field === 'cloudfrontCachePaths').status, 'unknown');
  const noBehaviours = collect('/w', env, io({ ...files, '/w/paths.out': 'None' }));
  assert.equal(compare(FACTS, noBehaviours).find((r) => r.field === 'cloudfrontCachePaths').status, 'DRIFT');
  const nothing = collect('/w', { PLAN_EXIT: 'null' }, io({}));
  assert.ok(compare(FACTS, nothing).every((r) => r.status === 'unknown'), 'an empty work directory is all unknown');
  assert.equal(report({ ...nothing, rows: compare(FACTS, nothing) }).exitCode, 1);
});

test('report prints fields and identifiers only, and the CLI exits with its code', () => {
  const rows = compare(FACTS, { ...OBSERVED, alarms: 33 });
  const r = report({ rows, ...QUIET });
  assert.match(r.text, /alarms\s+31\s+33\s+DRIFT/);
  const dir = mkdtempSync(join(tmpdir(), 'staging-status-'));
  const write = (name, value) => { writeFileSync(join(dir, name), JSON.stringify(value)); return join(dir, name); };
  const out = run(['report', write('facts.json', FACTS), write('observed.json', { ...OBSERVED, ...QUIET, rows: undefined })]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const drift = run(['report', write('facts2.json', FACTS), write('observed2.json', { ...OBSERVED, alarms: 33, ...QUIET })]);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /DRIFT/);
  rmSync(dir, { recursive: true, force: true });
});
