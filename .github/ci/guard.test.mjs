// Run with: node --test .github/ci/guard.test.mjs   (pnpm test:ci-config)
// A cheap tripwire over the CI configuration, in the spirit of infrastructure/terraform/guard.test.mjs.
// It reads text; it cannot prove what GitHub will do. It stops the quiet mistakes:
//   - an Action referenced by a movable tag instead of a commit SHA,
//   - a renamed job that silently stops being a required check,
//   - the ruleset and the workflow drifting apart,
//   - the workflow gaining write permissions or running untrusted code with secrets.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { verifyAllProfiles, verifyRecoveryMetrics } from './verify-recovery-metrics.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const workflow = read('../workflows/ci.yml');
const ruleset = JSON.parse(read('../rulesets/main.json'));
const dependabot = read('../dependabot.yml');

function recoveryMetricControl() {
  const volume = bytes => ({ bytes, GB: bytes / 1e9, GiB: bytes / 1024 ** 3 });
  const metric = { format: 1, databaseRecoveryVerified: true, independentBytesRecovered: true, applicationRecoveryComplete: false, identityMode: 'translated-test-only', references: 5, recoveredObjects: 5, concurrency: 1,
    requiredByKind: Object.fromEntries(['lab-pdf', 'vcf', 'structured', 'text'].map(kind => [kind, { objects: kind === 'lab-pdf' ? 2 : 1, ...volume(10) }])),
    volumes: { restoredDatabase: volume(300), archive: volume(100), catalogue: volume(90), recoveredObjects: volume(40), read: volume(100), writeAttempted: volume(10) },
    seconds: { backupDownload: 1, catalogue: 1, restoreAndEvidence: 3, evidenceVerification: 2, total: 5 } };
  const measurements = Array.from({ length: 7 }, () => structuredClone(metric)); measurements.at(-1).volumes.writeAttempted = volume(0);
  return { format: 1, synthetic: true, status: 'passed', controls: Array.from({ length: 30 }, (_, i) => ({ name: 'control-' + i, passed: true })),
    runtime: { node: 'v22.22.0', platform: 'linux', architecture: 'x64', gitHead: 'a'.repeat(40), storage: 'loopback PostgreSQL/Moto; synthetic gateway, not AWS IAM', freshProcess: true }, sourceDatabase: volume(300), measurements, applicationRecoveryComplete: false, nativeReplicationVerified: false };
}

test('CI validates all three recovery artifacts after the service tiers', () => {
  const command = '      - name: Validate all three independent-recovery measurement profiles\n        run: node .github/ci/verify-recovery-metrics.mjs';
  assert.ok(workflow.includes(command));
  assert.ok(workflow.indexOf(command) > workflow.indexOf('TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm'));
  assert.ok(workflow.includes('path: apps/backend/test-results/independent-recovery-*.json'));
});

test('recovery evidence validator refuses false acceptance, incomplete controls, unknown fields and wrong denominators', () => {
  assert.equal(verifyRecoveryMetrics(recoveryMetricControl()), true);
  for (const mutate of [
    v => { v.applicationRecoveryComplete = true; }, v => { v.nativeReplicationVerified = true; },
    v => { v.controls.pop(); }, v => { v.controls[0].passed = false; }, v => { v.measurements.pop(); },
    v => { v.rawCatalogue = 'synthetic forbidden field'; }, v => { v.measurements[0].tenantId = 'synthetic forbidden field'; },
    v => { v.measurements[0].volumes.recoveredObjects.GB = 999; }, v => { v.measurements[0].independentBytesRecovered = false; },
    v => { v.measurements.at(-1).volumes.writeAttempted.bytes = 1; },
  ]) { const value = recoveryMetricControl(); mutate(value); assert.throws(() => verifyRecoveryMetrics(value)); }
});

test('recovery evidence requires each profile, not merely one matching artifact file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-metric-control-'));
  try {
    assert.throws(() => verifyAllProfiles(dir));
    for (const profile of ['memory', 'postgres']) writeFileSync(join(dir, 'independent-recovery-' + profile + '.json'), JSON.stringify(recoveryMetricControl()));
    assert.throws(() => verifyAllProfiles(dir));
    writeFileSync(join(dir, 'independent-recovery-postgres-s3.json'), JSON.stringify(recoveryMetricControl()));
    assert.doesNotThrow(() => verifyAllProfiles(dir));
    assert.doesNotThrow(() => verifyAllProfiles(dir, 'a'.repeat(40)));
    assert.throws(() => verifyAllProfiles(dir, 'b'.repeat(40)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Jobs that deliberately are NOT required checks. Anything else in ci.yml must be required. */
const ADVISORY = new Set(['terraform-lint']);

/** { key, name } for each job under `jobs:`; a job with `continue-on-error: true` cannot be a gate. */
function jobsOf(text) {
  const body = text.split(/^jobs:\s*$/m)[1] ?? '';
  const jobs = [];
  for (const block of body.split(/^  (?=[a-z][a-z0-9-]*:\s*$)/m).slice(1)) {
    const key = block.match(/^([a-z][a-z0-9-]*):/)[1];
    const name = block.match(/^    name:\s*(\S+)\s*$/m)?.[1];
    jobs.push({ key, name, continueOnError: /^    continue-on-error:\s*true\s*$/m.test(block) });
  }
  return jobs;
}

test('the workflow has jobs (the parser found something to check)', () => {
  assert.ok(jobsOf(workflow).length >= 5, 'expected at least five jobs');
});

test('every action is pinned to a full commit SHA with a version comment', () => {
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 10, 'expected the workflow to use several actions');
  for (const [, ref, rest] of uses) {
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} must be pinned to a 40-character commit SHA`);
    assert.match(rest, /#\s*v\d/, `${ref} needs a "# vX.Y.Z" comment recording the version`);
  }
});

test('permissions are read-only at the top and nothing widens them', () => {
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(workflow, /:\s*write\b/, 'no job may request a write permission');
});

test('untrusted code never runs with secrets: no pull_request_target, no repository secrets', () => {
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test('the database job fails when a test tier was skipped instead of passing quietly', () => {
  assert.ok((workflow.match(/! grep -F "\[jest\] NOT RUNNING"/g) ?? []).length >= 3, 'each of the three tiers must check for the NOT RUNNING notice');
  for (const v of ['TEST_DATABASE_URL', 'TEST_S3_ENDPOINT', 'TEST_STORAGE=postgres', 'TEST_OBJECT_STORAGE=s3']) assert.ok(workflow.includes(v), `${v} must be set somewhere`);
});

test('Node is pinned to an exact release, because the unavailable-value matcher is pinned to a Unicode version', () => {
  const version = workflow.match(/^ {2}NODE_VERSION:\s*"([^"]+)"/m)?.[1];
  assert.ok(version, 'the workflow must define NODE_VERSION');
  assert.match(version, /^\d+\.\d+\.\d+$/, 'NODE_VERSION must be an exact release such as 22.22.0, not a floating major');
});

test('each job is named like its key, so the check name is predictable', () => {
  for (const job of jobsOf(workflow)) assert.equal(job.name, job.key, `job ${job.key} must have "name: ${job.key}"`);
});

test('the ruleset requires exactly the non-advisory jobs of the workflow', () => {
  const gates = jobsOf(workflow).filter((j) => !ADVISORY.has(j.key)).map((j) => j.name).sort();
  const required = ruleset.rules
    .find((r) => r.type === 'required_status_checks')
    .parameters.required_status_checks.map((c) => c.context)
    .sort();
  assert.deepEqual(required, gates);
  for (const j of jobsOf(workflow)) if (ADVISORY.has(j.key)) assert.ok(j.continueOnError, `${j.key} is advisory, so it must be continue-on-error`);
  for (const j of jobsOf(workflow)) if (!ADVISORY.has(j.key)) assert.ok(!j.continueOnError, `${j.key} is a gate, so it must not be continue-on-error`);
});

/** The steps (`run:` lines, in order) of one job of ci.yml. */
function runSteps(text, key) {
  const body = text.split(/^jobs:\s*$/m)[1] ?? '';
  const block = body.split(/^  (?=[a-z][a-z0-9-]*:\s*$)/m).find((b) => b.startsWith(`${key}:`)) ?? '';
  return [...block.matchAll(/^ {6}- run:\s*(.+)$/gm)].map((m) => m[1].trim());
}

/** What is wrong with how the terraform job proves the deployment profiles (empty when nothing is). */
export function terraformJobProblems(text) {
  const steps = runSteps(text, 'terraform');
  const problems = [];
  const at = (command) => steps.indexOf(command);
  if (at('terraform test') < 0) problems.push('the terraform job must run `terraform test` (the offline per-profile plans in profiles.tftest.hcl)');
  if (at('terraform init -backend=false -input=false') < 0 || at('terraform init -backend=false -input=false') > at('terraform test')) problems.push('terraform test must run after `terraform init -backend=false`');
  const job = text.split(/^jobs:\s*$/m)[1]?.split(/^ {2}(?=[a-z][a-z0-9-]*:\s*$)/m).find((b) => b.startsWith('terraform:')) ?? '';
  if (/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|ROLE_ARN)|role-to-assume|configure-aws-credentials/.test(job)) problems.push('the terraform job must hold no cloud credentials');
  return problems;
}

test('the terraform job runs the offline profile tests, after init, and holds no credentials', () => {
  assert.deepEqual(terraformJobProblems(workflow), []);
});

test('the terraform job check reports a missing test step, a wrong order and a credential (controls)', () => {
  assert.ok(terraformJobProblems(workflow.replace(/^ {6}- run: terraform test\n/m, '')).length > 0, 'a job without terraform test must be reported');
  const reordered = workflow.replace('      - run: terraform init -backend=false -input=false\n', '').replace('      - run: terraform test\n', '      - run: terraform test\n      - run: terraform init -backend=false -input=false\n');
  assert.ok(terraformJobProblems(reordered).length > 0, 'a test before init must be reported');
  assert.ok(terraformJobProblems(workflow.replace('      - run: terraform test\n', '      - run: terraform test\n        env:\n          AWS_ACCESS_KEY_ID: x\n')).length > 0, 'a credential must be reported');
});

test('the ruleset protects the default branch and blocks force-push and deletion', () => {
  assert.deepEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.equal(ruleset.enforcement, 'active');
  const types = ruleset.rules.map((r) => r.type);
  for (const t of ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']) assert.ok(types.includes(t), `missing rule ${t}`);
});

test('required checks come from GitHub Actions only (so another app cannot report them)', () => {
  const checks = ruleset.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks;
  for (const c of checks) assert.equal(c.integration_id, 15368, `${c.context} must be bound to the GitHub Actions app`);
});

test('dependabot watches every ecosystem the repository uses', () => {
  for (const eco of ['npm', 'github-actions', 'terraform', 'pip', 'docker-compose']) assert.match(dependabot, new RegExp(`package-ecosystem: ${eco}\\b`));
});

// ---- CLAUDE.md is a pointer: it must stay short and may only name files that exist ----

const REPO = new URL('../../', import.meta.url);
const PATH_PATTERN = /(?:\b(?:docs|apps|packages|infrastructure|\.github)\/[\w./-]*[\w-]|\bCONTRIBUTING\.md|\bREADME\.md|\bSECURITY\.md)/g;

/** Every repository path a piece of text names, with the ones that do not exist on disk. */
export function pathsIn(text) {
  const named = [...new Set(text.match(PATH_PATTERN) ?? [])];
  return { named, missing: named.filter((p) => !existsSync(new URL(p, REPO))) };
}

test('CLAUDE.md is a short pointer that names only files that exist', () => {
  const text = read('../../CLAUDE.md');
  const { named, missing } = pathsIn(text);
  assert.ok(named.length >= 5, `expected CLAUDE.md to name at least 5 files, found ${named.length}: a scan that finds nothing proves nothing`);
  assert.deepEqual(missing, [], `CLAUDE.md names files that do not exist: ${missing.join(', ')}`);
  assert.ok(text.split('\n').length <= 30, 'CLAUDE.md is a pointer; the rules belong in docs/STATUS.md and CONTRIBUTING.md');
});

test('the CLAUDE.md path check detects a missing file and passes a real one (controls)', () => {
  assert.deepEqual(pathsIn('See `docs/no-such-page.md` and docs/STATUS.md').missing, ['docs/no-such-page.md']);
  assert.deepEqual(pathsIn('See docs/STATUS.md and CONTRIBUTING.md').missing, []);
  assert.deepEqual(pathsIn('no paths at all').named, []);
});

export function imageJobProblems(text) {
  const block=text.split(/^jobs:\s*$/m)[1]?.split(/^ {2}(?=[a-z][a-z0-9-]*:\s*$)/m).find(b=>b.startsWith('image:')) || '';
  const rules=[
    ['no push', /push: false/], ['SBOM', /sbom: true/], ['provenance', /provenance: mode=max/],
    ['runtime load', /load: true/], ['OCI evidence', /type=oci,dest=/], ['scan blocks', /exit-code: '1'/], ['fixed high critical', /severity: CRITICAL,HIGH/],
    ['fixed only', /ignore-unfixed: true/], ['reviewed exceptions', /trivyignores: infrastructure\/docker\/trivy.ignore/],
    ['rehearsal', /node infrastructure\/docker\/rehearsal.cjs/], ['guards', /node --test infrastructure\/docker\/guard.test.mjs/],
  ];
  const failures=rules.filter(([,pattern])=>!pattern.test(block)).map(([name])=>name);
  if((block.match(/push: false/g) || []).length!==2 || /push: true/.test(block))failures.push('no push');
  if(/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|ROLE_ARN)|configure-aws-credentials|role-to-assume/.test(block))failures.push('cloud credentials');
  return failures;
}
test('image job builds with retained attestations, blocks vulnerabilities and rehearses without cloud credentials',()=>assert.deepEqual(imageJobProblems(workflow),[]));
for(const [token,rule] of [['load: true','runtime load'],['push: false','no push'],['sbom: true','SBOM'],['provenance: mode=max','provenance'],['type=oci,dest=','OCI evidence'],["exit-code: '1'",'scan blocks'],['severity: CRITICAL,HIGH','fixed high critical'],['ignore-unfixed: true','fixed only'],['trivyignores: infrastructure/docker/trivy.ignore','reviewed exceptions'],['node infrastructure/docker/rehearsal.cjs','rehearsal'],['node --test infrastructure/docker/guard.test.mjs','guards']]) {
  test(`image job detects missing ${rule} (control)`,()=>assert.ok(imageJobProblems(workflow.replace(token,'removed')).includes(rule)));
}

// Execute the three actual tier scripts with a stub test command. A failed producer must
// survive tee; a skipped service must fail; successful tests must retain their log.
test('database tier pipelines preserve test failures and missing-service refusal', () => {
  const scripts = [...workflow.matchAll(/^ {8}run: \|\n((?: {10}.*\n)+)/gm)]
    .map(m => m[1].replace(/^ {10}/gm, '')).filter(script => /\| tee tier[123]\.log/.test(script));
  assert.equal(scripts.length, 3, 'all three database tier scripts must be exercised');
  const dir = mkdtempSync(join(tmpdir(), 'ci-tier-controls-'));
  try {
    for (const script of scripts) {
      const run = (status, message) => spawnSync('bash', ['-e', '-c',
        'pnpm() { printf "%s\\n" "$fixture_message"; return "$fixture_status"; }\n' + script],
      { cwd: dir, env: { ...process.env, fixture_status: String(status), fixture_message: message }, encoding: 'utf8' });
      assert.equal(run(17, 'fixture test failed').status, 17, 'tee must not hide a failed test producer');
      assert.notEqual(run(0, '[jest] NOT RUNNING fixture service').status, 0, 'missing services must fail');
      assert.equal(run(0, 'fixture tests passed').status, 0, 'successful tests must pass');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
