// Run with: node --test .github/ci/guard.test.mjs   (pnpm test:ci-config)
// A cheap tripwire over the CI configuration, in the spirit of infrastructure/terraform/guard.test.mjs.
// It reads text; it cannot prove what GitHub will do. It stops the quiet mistakes:
//   - an Action referenced by a movable tag instead of a commit SHA,
//   - a renamed job that silently stops being a required check,
//   - the ruleset and the workflow drifting apart,
//   - the workflow gaining write permissions or running untrusted code with secrets.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { recoveryMetricControl, applicationMetricControl } from './fixtures/recovery.mjs';
import { serviceLayoutProblems, internalJobs, withoutScopeGate } from './service-layout.mjs';
import { verifyAllProfiles, verifyRecoveryMetrics } from './verify-recovery-metrics.mjs';
import { verifyApplicationRecovery, verifyApplicationProfiles } from './verify-application-recovery.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const workflow = read('../workflows/ci.yml');
const ruleset = JSON.parse(read('../rulesets/main.json'));
const dependabot = read('../dependabot.yml');

test('CI runs the worker against PostgreSQL after the API tiers, and a skipped tier fails the job', () => {
  const step = workflow.indexOf('pnpm --filter @telesphoros/worker test 2>&1 | tee tier-worker.log');
  assert.ok(step > workflow.indexOf('TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm'));
  assert.ok(workflow.slice(step, step + 200).includes('! grep -F "NOT RUNNING" tier-worker.log'));
  assert.ok(workflow.includes('tier*.log'));
});

test('CI validates the expected recovery artifacts after the service tiers', () => {
  const command = '      - name: Validate the expected independent-recovery measurement profiles\n        run: node .github/ci/verify-recovery-metrics.mjs';
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


test('application recovery gates all profiles after tiers and retains aggregate artifacts', () => {
  const command = '        run: node .github/ci/verify-application-recovery.mjs';
  assert.ok(workflow.includes(command)); assert.ok(workflow.indexOf(command) > workflow.indexOf('TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3 pnpm'));
  assert.ok(workflow.includes('path: apps/backend/test-results/application-recovery-*.json'));
  assert.equal(verifyApplicationRecovery(applicationMetricControl()), true);
});
test('application recovery refuses incomplete/false acceptance, privacy drift and incorrect volume or timing', () => {
  for (const mutate of [v => { v.clinicalUseApproved = true; }, v => { v.applicationRecoveryComplete = false; }, v => { v.controls.pop(); },
    v => { v.controls[0].passed = false; }, v => { v.rawCatalogue = 'forbidden'; }, v => { v.measurements[0].application.url = 'forbidden'; }, v => { v.measurements[0].application.apiControls.pop(); },
    v => { v.measurements[0].recovery.volumes.recoveredObjects.GB = 999; }, v => { v.measurements[0].application.seconds = Infinity; },
    v => { v.measurements[0].application.applicationRecoveryComplete = false; }, v => { v.measurements[1].recovery.volumes.writeAttempted.bytes = 1; }]) {
    const value = applicationMetricControl(); mutate(value); assert.throws(() => verifyApplicationRecovery(value));
  }
});
test('application recovery requires three artifacts at the expected checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'application-metric-controls-'));
  try {
    assert.throws(() => verifyApplicationProfiles(dir));
    for (const profile of ['memory', 'postgres']) writeFileSync(join(dir, 'application-recovery-' + profile + '.json'), JSON.stringify(applicationMetricControl()));
    assert.throws(() => verifyApplicationProfiles(dir));
    writeFileSync(join(dir, 'application-recovery-postgres-s3.json'), JSON.stringify(applicationMetricControl()));
    assert.doesNotThrow(() => verifyApplicationProfiles(dir, 'a'.repeat(40))); assert.throws(() => verifyApplicationProfiles(dir, 'b'.repeat(40)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Jobs that deliberately are NOT required checks. Anything else in ci.yml must be required. */
const ADVISORY = new Set(['terraform-lint']);
/** Jobs that run only after a merge to main (so a pull request cannot wait on them), yet must fail visibly: not required, never continue-on-error. */
const AFTER_MERGE = new Set(['release-image']);
/** Helper jobs that decide what the others do. Not required and not advisory: a failure here makes every gate run (scope.test.mjs). */
const SUPPORT = new Set(['changes']);

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

test('permissions are read-only at the top and nothing widens them, except the one id-token of the release job', () => {
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  // INF-03 (specs/002-signed-image-release): release-image needs an OIDC token to reach AWS without a stored secret. That is the only write anywhere.
  const writes = workflow.split('\n').filter((line) => !/^\s*#/.test(line) && /:\s*write\b/.test(line));
  assert.deepEqual(writes, ['      id-token: write'], 'no job may request a write permission, except id-token on release-image');
  const release = (workflow.split(/^jobs:\s*$/m)[1] ?? '').split(/^  (?=[a-z][a-z0-9-]*:\s*$)/m).find((b) => b.startsWith('release-image:')) ?? '';
  assert.ok(release.includes('      id-token: write'), 'the one id-token write must belong to release-image');
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
  const gates = jobsOf(workflow).filter((j) => !ADVISORY.has(j.key) && !AFTER_MERGE.has(j.key) && !SUPPORT.has(j.key) && !internalJobs.includes(j.key)).map((j) => j.name).sort();
  const required = ruleset.rules
    .find((r) => r.type === 'required_status_checks')
    .parameters.required_status_checks.map((c) => c.context)
    .sort();
  assert.deepEqual(required, gates);
  assert.deepEqual(serviceLayoutProblems(workflow), [], 'internal producers must all feed the required joining gate');
  for (const j of jobsOf(workflow)) if (ADVISORY.has(j.key)) assert.ok(j.continueOnError, `${j.key} is advisory, so it must be continue-on-error`);
  for (const j of jobsOf(workflow)) if (!ADVISORY.has(j.key)) assert.ok(!j.continueOnError, `${j.key} is a gate or runs after merge, so it must not be continue-on-error`);
  for (const key of AFTER_MERGE) assert.ok(jobsOf(workflow).some((j) => j.key === key), `${key} is listed as after-merge but is not in the workflow`);
});

/** The steps (`run:` lines, in order) of one job of ci.yml. */
function runSteps(text, key) {
  const body = text.split(/^jobs:\s*$/m)[1] ?? '';
  const block = body.split(/^  (?=[a-z][a-z0-9-]*:\s*$)/m).find((b) => b.startsWith(`${key}:`)) ?? '';
  return [...block.matchAll(/^ {6}- run:\s*(.+)$/gm)].map((m) => m[1].trim());
}

/** The native launcher check belongs to the required browser job, with its dependencies ready. */
export function launcherCorsJobProblems(text) {
  const command = 'pnpm test:launcher-cors';
  const job = text.split(/^jobs:\s*$/m)[1]?.split(/^ {2}(?=[a-z][a-z0-9-]*:\s*$)/m).find(b => b.startsWith('browser:')) ?? '';
  const problems = [];
  if (/^ {4}if:/m.test(withoutScopeGate(job))) problems.push('the required browser job must not be conditional');
  if (runSteps(text, 'browser').filter(s => s === command).length !== 1) problems.push('one native launcher test command is required');
  const step = job.split(/^ {6}(?=- )/m).find(b => b.startsWith('- run: ' + command)) ?? '';
  if (step.trim() !== '- run: ' + command) problems.push('the launcher step must run unconditionally and propagate failure');
  const at = job.indexOf(command);
  for (const dependency of ['pip install --require-hashes -r .github/ci/requirements.txt', 'pnpm exec playwright install-deps chromium', 'pnpm exec playwright install --with-deps chromium']) {
    if (job.indexOf(dependency) < 0 || job.indexOf(dependency) > at) problems.push('launcher dependencies must precede the native check');
  }
  return problems;
}

test('required browser CI runs self-contained launcher origin controls after dependencies are installed', () => {
  assert.deepEqual(launcherCorsJobProblems(workflow), []);
  const pkg = JSON.parse(read('../../package.json'));
  assert.equal(pkg.scripts['test:launcher-cors'], 'node --test scripts/local-storage/launcher-cors.test.cjs');
  assert.ok(existsSync(new URL('../../scripts/local-storage/launcher-cors.test.cjs', import.meta.url)));
});

test('launcher CI guard rejects missing, swallowed, optional and premature native checks', () => {
  const step = '      - run: pnpm test:launcher-cors\n';
  for (const changed of [
    workflow.replace(step, ''),
    workflow.replace(step, step + step),
    workflow.replace(step, step.trimEnd() + ' || true\n'),
    workflow.replace(step, step + '        continue-on-error: true\n'),
    workflow.replace(step, step + '        if: false\n'),
    workflow.replace('  browser:\n', '  browser:\n    if: false\n'),
    workflow.replace(step, '').replace('      - name: Install the browser\n', step + '      - name: Install the browser\n'),
  ]) assert.ok(launcherCorsJobProblems(changed).length > 0);
});

test('the actual launcher CI command propagates a failed test producer', () => {
  const command = runSteps(workflow, 'browser').find(s => s === 'pnpm test:launcher-cors');
  assert.ok(command);
  for (const status of [0, 17]) {
    const result = spawnSync('bash', ['-e', '-c', `pnpm() { return ${status}; };\n${command}`], { encoding: 'utf8' });
    assert.equal(result.status, status);
  }
});

const terraformCommands = ['infrastructure/terraform', 'infrastructure/terraform-state'].flatMap(root => [
  `terraform -chdir=${root} fmt -check -recursive -diff`,
  `terraform -chdir=${root} init -backend=false -input=false -lockfile=readonly`,
  `terraform -chdir=${root} validate`,
  `terraform -chdir=${root} test -no-color`,
]).concat(['node --test infrastructure/terraform-state/guard.test.mjs', 'node --test infrastructure/terraform-state/policy.test.mjs']);
const policyEvidenceEnv = '\n        env:\n          FD7A_TEST_EVIDENCE_DIR: ${{ runner.temp }}';
const terraformNode = '- uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: ${{ env.NODE_VERSION }}';
const terraformSetup = '- uses: hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1\n        with:\n          terraform_version: "1.16.5"\n          terraform_wrapper: false';
const policyRetention = '- name: Retain standalone policy producer evidence\n        if: always()\n        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n        with:\n          name: fd7a-policy-producer-${{ github.run_attempt }}\n          path: ${{ runner.temp }}/fd7a-policy-*/\n          retention-days: 7\n          if-no-files-found: error';

/** Required commands are deliberately canonical: wrappers/conditions must not turn failure into acceptance. */
export function terraformJobProblems(text) {
  const job = text.split(/^jobs:\s*$/m)[1]?.split(/^ {2}(?=[a-z][a-z0-9-]*:\s*$)/m).find(b => b.startsWith('terraform:')) ?? '';
  const steps = runSteps(text, 'terraform');
  const blocks = job.split(/^ {6}(?=- )/m).slice(1).map(b => b.split('\n').filter(line => !/^\s*(?:#.*)?$/.test(line)).join('\n').trim());
  const problems = [];
  if (JSON.stringify(steps) !== JSON.stringify(terraformCommands)) problems.push('both roots require every unfiltered command in order');
  if (blocks.length !== terraformCommands.length + 4) problems.push('unexpected or missing Terraform job step');
  if (/^ {4}(?:if|continue-on-error|defaults|env):/m.test(withoutScopeGate(job)) || /^defaults:/m.test(text.split(/^jobs:\s*$/m)[0])) problems.push('Terraform gate must be unconditional and run from the repository root');
  if (!/^ {4}timeout-minutes: 15$/m.test(job)) problems.push('retain the existing Terraform timeout');
  if (!/^ {2}NODE_VERSION: "22\.22\.0"$/m.test(text)) problems.push('retain the exact Node runtime');
  for (const command of terraformCommands) {
    const expected = '- run: ' + command + (command.endsWith('/policy.test.mjs') ? policyEvidenceEnv : '');
    if (blocks.filter(b => b === expected).length !== 1) problems.push('required command must propagate failure without step overrides: ' + command);
  }
  for (const [expected, label] of [[terraformNode, 'pinned Node setup'], [terraformSetup, 'pinned Terraform setup'], [policyRetention, 'native policy evidence retention']]) {
    if (blocks.filter(b => b === expected).length !== 1) problems.push(label);
  }
  for (const setup of [terraformNode, terraformSetup]) if (blocks.indexOf(setup) < 0 || blocks.indexOf(setup) > blocks.findIndex(b => b.startsWith('- run:'))) problems.push('runtimes must precede every producer');
  if (!blocks[0]?.startsWith('- uses: actions/checkout@')) problems.push('checkout must precede setup and producers');
  if (blocks.at(-1) !== policyRetention) problems.push('retain native policy evidence after the producers');
  if (/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|ROLE_ARN)|role-to-assume|configure-aws-credentials/.test(job)) problems.push('the terraform job must hold no cloud credentials');
  if (/^ {2}(?:FD7A_|TF_|NODE_OPTIONS)/m.test(text.split(/^jobs:\s*$/m)[0])) problems.push('no global producer or test-selection override');
  return [...new Set(problems)];
}

test('the terraform job runs the offline profile tests, after init, and holds no credentials', () => {
  assert.deepEqual(terraformJobProblems(workflow), []);
});

test('the terraform job check reports a missing test step, a wrong order and a credential (controls)', () => {
  const init = '      - run: ' + terraformCommands[1] + '\n';
  const plan = '      - run: ' + terraformCommands[3] + '\n';
  assert.ok(terraformJobProblems(workflow.replace(plan, '')).length > 0, 'a job without terraform test must be reported');
  const reordered = workflow.replace(init, '').replace(plan, plan + init);
  assert.ok(terraformJobProblems(reordered).length > 0, 'a test before init must be reported');
  assert.ok(terraformJobProblems(workflow.replace(plan, plan + '        env:\n          AWS_ACCESS_KEY_ID: x\n')).length > 0, 'a credential must be reported');
});

test('required Terraform CI selects standalone state plans, source guards and fresh policy tests', () => {
  const steps = runSteps(workflow, 'terraform');
  for (const command of [
    'terraform -chdir=infrastructure/terraform-state fmt -check -recursive -diff',
    'terraform -chdir=infrastructure/terraform-state init -backend=false -input=false -lockfile=readonly',
    'terraform -chdir=infrastructure/terraform-state validate',
    'terraform -chdir=infrastructure/terraform-state test -no-color',
    'node --test infrastructure/terraform-state/guard.test.mjs',
    'node --test infrastructure/terraform-state/policy.test.mjs',
  ]) assert.ok(steps.includes(command), `missing required command: ${command}`);
  for (const path of ['main.tf', '.terraform.lock.hcl', 'state.tftest.hcl', 'tests/policy.tftest.hcl', 'guard.test.mjs', 'policy.test.mjs', 'policy-probes.mjs']) {
    assert.ok(existsSync(new URL('../../infrastructure/terraform-state/' + path, import.meta.url)), `missing state-root input: ${path}`);
  }
});

test('the ruleset protects the default branch and blocks force-push and deletion', () => {
  assert.deepEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.equal(ruleset.enforcement, 'active');
  const types = ruleset.rules.map((r) => r.type);
  for (const t of ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']) assert.ok(types.includes(t), `missing rule ${t}`);
});

// Founder decision 2026-10-19 (security audit INF-05): nobody bypasses the checks, and a pull request must be current with main
// when it merges. Break-glass is now a visible ruleset edit (docs/ops/ci-cd.md), not a standing bypass.
test('nobody can bypass the ruleset, and a pull request must be up to date with main to merge', () => {
  assert.deepEqual(ruleset.bypass_actors, [], 'no bypass actors: a standing bypass lets one account merge past failing checks');
  const checks = ruleset.rules.find((r) => r.type === 'required_status_checks').parameters;
  assert.equal(checks.strict_required_status_checks_policy, true, 'checks must have run against the current main');
});

// Applying this file through the API on 2026-10-20 silently turned require_extra_approval_for_unattributed_changes on: a field the
// file does not name takes GitHub's default, not the live value. With one maintainer and 0 approvals, an extra required approval
// could block merges. The file therefore names it explicitly; the live value before the sync was false.
test('the pull-request rule pins the extra-approval-for-unattributed-changes setting off', () => {
  const pr = ruleset.rules.find((r) => r.type === 'pull_request').parameters;
  assert.ok(Object.hasOwn(pr, 'require_extra_approval_for_unattributed_changes'), 'name it explicitly, or an API sync applies GitHub\'s default (true)');
  assert.equal(pr.require_extra_approval_for_unattributed_changes, false);
});

test('required checks come from GitHub Actions only (so another app cannot report them)', () => {
  const checks = ruleset.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks;
  for (const c of checks) assert.equal(c.integration_id, 15368, `${c.context} must be bound to the GitHub Actions app`);
});

test('dependabot watches every ecosystem the repository uses', () => {
  for (const eco of ['npm', 'github-actions', 'terraform', 'pip', 'docker-compose']) assert.match(dependabot, new RegExp(`package-ecosystem: ${eco}\\b`));
});

/** Dependencies Dependabot must not bump alone: @nestjs/* majors (they move together), jsdom majors (30 needs a Node the Unicode pin rules out), and
 *  every Node base-image update (an exact pin held in many files). */
export function missingIgnores(config) {
  const block = (eco) => config.split(/^  - package-ecosystem: /m).find((b) => b.startsWith(`${eco}\n`)) ?? '';
  const majors = (name) => (entries) => entries.some((e) => e.name === name && e.next.trim() === 'update-types: ["version-update:semver-major"]');
  const node = (entries) => entries.some((e) => e.name === 'node' && !/^\s*update-types/.test(e.next)); // no update-types: every update is ignored
  return [['npm', '@nestjs/*', majors('@nestjs/*')], ['npm', 'jsdom', majors('jsdom')], ['docker', 'node', node]].filter(([eco, , ok]) => !ok(ignoreEntries(block(eco)))).map(([eco, name]) => `${eco}: ${name}`);
}
/** The `- dependency-name:` entries of a block's `ignore:` list, each with the line that follows it. Read line by line: linear in the file, whatever it contains. */
function ignoreEntries(block) {
  const lines = block.split('\n');
  const at = lines.findIndex((l) => l.trim() === 'ignore:');
  if (at < 0) return [];
  const indent = /^\s*/.exec(lines[at])[0].length;
  const entries = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (/^\s*/.exec(lines[i])[0].length <= indent) break;
    const name = /^\s*- dependency-name: "([^"]*)"\s*$/.exec(lines[i]);
    if (name) entries.push({ name: name[1], next: lines[i + 1] ?? '' });
  }
  return entries;
}
test('dependabot ignores @nestjs/* and jsdom majors and every update of the node base image (planned migrations only)', () => {
  assert.deepEqual(missingIgnores(dependabot), []);
  assert.deepEqual(missingIgnores(dependabot.replace('"@nestjs/*"', '"@nestjs/core"')), ['npm: @nestjs/*']); // controls: each fails when removed
  assert.deepEqual(missingIgnores(dependabot.replace('dependency-name: "jsdom"', 'dependency-name: "jsdomx"')), ['npm: jsdom']);
  assert.deepEqual(missingIgnores(dependabot.replace('dependency-name: "jsdom"\n        update-types: ["version-update:semver-major"]\n', 'dependency-name: "jsdom"\n')), ['npm: jsdom']); // without update-types the whole package would be frozen
  assert.deepEqual(missingIgnores(dependabot.replace('dependency-name: "node"', 'dependency-name: "nodex"')), ['docker: node']);
  assert.deepEqual(missingIgnores(dependabot.replace('dependency-name: "node"\n', 'dependency-name: "node"\n        update-types: ["version-update:semver-major"]\n')), ['docker: node']); // majors only is not enough
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
    ['archive image loaded', /infrastructure\/docker\/load-archive-image\.sh "\$RUNNER_TEMP\/api\.oci\.tar" telesphoros-fd4b:rehearsal/], ['OCI evidence', /type=oci,dest=/], ['scan blocks', /exit-code: '1'/], ['fixed high critical', /severity: CRITICAL,HIGH/],
    ['fixed only', /ignore-unfixed: true/], ['reviewed exceptions', /trivyignores: infrastructure\/docker\/trivy.ignore/],
    ['rehearsal', /node infrastructure\/docker\/rehearsal.cjs/], ['guards', /node --test infrastructure\/docker\/guard.test.mjs/],
  ];
  const failures=rules.filter(([,pattern])=>!pattern.test(block)).map(([name])=>name);
  if((block.match(/push: false/g) || []).length!==1 || /push: true/.test(block))failures.push('no push');
  // INF-03: what is scanned must be the archive that is released, never a second build (a second `--load` build differed, 2026-10-21).
  if(/load: true/.test(block))failures.push('archive image loaded');
  if(/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|ROLE_ARN)|configure-aws-credentials|role-to-assume/.test(block))failures.push('cloud credentials');
  return failures;
}
test('image job builds with retained attestations, blocks vulnerabilities and rehearses without cloud credentials',()=>assert.deepEqual(imageJobProblems(workflow),[]));
for(const [token,rule] of [['infrastructure/docker/load-archive-image.sh','archive image loaded'],['push: false','no push'],['sbom: true','SBOM'],['provenance: mode=max','provenance'],['type=oci,dest=','OCI evidence'],["exit-code: '1'",'scan blocks'],['severity: CRITICAL,HIGH','fixed high critical'],['ignore-unfixed: true','fixed only'],['trivyignores: infrastructure/docker/trivy.ignore','reviewed exceptions'],['node infrastructure/docker/rehearsal.cjs','rehearsal'],['node --test infrastructure/docker/guard.test.mjs','guards']]) {
  test(`image job detects missing ${rule} (control)`,()=>assert.ok(imageJobProblems(workflow.replace(token,'removed')).includes(rule)));
}

// Execute the three actual tier scripts with a stub test command. A failed producer must
// survive tee; a skipped service must fail; successful tests must retain their log.
test('database tier pipelines preserve test failures and missing-service refusal', () => {
  const scripts = [...workflow.matchAll(/^          node \.github\/ci\/service-evidence\.mjs run [a-z0-9-]+ <<'PROFILE'\n([\s\S]*?)^          PROFILE$/gm)]
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

test('real PostgreSQL suites use one worker without extending test deadlines or changing discovery', () => {
  const config = new URL('../../apps/backend/jest.config.js', import.meta.url).pathname;
  const load = database => {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1])))', config], {
      encoding: 'utf8', env: { ...process.env, TEST_DATABASE_URL: database, TEST_S3_ENDPOINT: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const memory = load('');
  const postgres = load('postgres://synthetic.invalid/contract-only'); // parsed configuration only; never connects
  assert.equal(postgres.maxWorkers, 1);
  assert.equal(memory.maxWorkers, undefined, 'unit-only runs retain Jest worker defaults');
  assert.equal(postgres.testTimeout, undefined, 'keep the existing Jest five-second deadline');
  assert.equal(memory.testTimeout, undefined);
  assert.equal(postgres.testRegex, memory.testRegex);
  assert.ok(!postgres.testPathIgnorePatterns.includes('/test/db/'), 'database tests must remain enabled');
});


for (const command of terraformCommands) {
  test(`Terraform gate refuses omitted producer: ${command}`, () => {
    const changed = workflow.replace('      - run: ' + command + '\n', '');
    assert.notEqual(changed, workflow);
    assert.ok(terraformJobProblems(changed).length > 0);
  });
}

test('Terraform gate refuses optional, swallowed, filtered, cached or misplaced coverage', () => {
  const variants = [];
  for (const command of terraformCommands) {
    const line = '      - run: ' + command + '\n';
    for (const suffix of [' || true', '; true', ' --test-skip-pattern=.', ' -filter=state.tftest.hcl']) variants.push(workflow.replace(line, line.trimEnd() + suffix + '\n'));
    for (const override of ['if: false', 'continue-on-error: true', 'working-directory: infrastructure/terraform', 'shell: bash {0}']) variants.push(workflow.replace(line, line + '        ' + override + '\n'));
  }
  for (const setting of ['if: false', 'continue-on-error: true', 'defaults:\n      run:\n        working-directory: infrastructure/terraform', 'env:\n      FD7A_TERRAFORM_BIN: cached-producer']) variants.push(workflow.replace('  terraform:\n', '  terraform:\n    ' + setting + '\n'));
  variants.push(workflow.replace('jobs:\n', 'defaults:\n  run:\n    working-directory: infrastructure/terraform\njobs:\n'));
  variants.push(workflow.replace('  NODE_VERSION: "22.22.0"', '  NODE_VERSION: "22"'));
  variants.push(workflow.replace('  NODE_VERSION: "22.22.0"', '  NODE_VERSION: "22.22.0"\n  TF_CLI_ARGS_test: -filter=tests/policy.tftest.hcl'));
  variants.push(workflow.replace('  terraform:\n', '  terraform:\n    # adversarial cached result step\n    steps:\n      - uses: actions/cache@' + 'a'.repeat(40) + ' # v1\n'));
  variants.push(workflow.replace(terraformCommands[1], terraformCommands[1].replace(' -lockfile=readonly', '')));
  variants.push(workflow.replace(terraformCommands[5], terraformCommands[5].replace(' -backend=false', '')));
  for (const changed of variants) { assert.notEqual(changed, workflow); assert.ok(terraformJobProblems(changed).length > 0); }
});

test('Terraform gate requires pinned runtimes before producers and retains native policy evidence', () => {
  const start = workflow.indexOf('  terraform:\n');
  const end = workflow.indexOf('  terraform-lint:\n', start);
  const job = workflow.slice(start, end);
  const inTerraform = (before, after) => {
    assert.ok(job.includes(before), 'mutation must select the Terraform job');
    return workflow.slice(0, start) + job.replace(before, after) + workflow.slice(end);
  };
  const variants = [
    inTerraform(terraformNode, ''), inTerraform(terraformSetup, ''), inTerraform(policyRetention, ''),
    inTerraform(terraformNode, terraformNode.replace('node-version: ${{ env.NODE_VERSION }}', 'node-version: 24')),
    inTerraform(terraformSetup, terraformSetup.replace('1.16.5', '1.16.4')),
    inTerraform(terraformSetup, terraformSetup.replace('terraform_wrapper: false', 'terraform_wrapper: true')),
    inTerraform(terraformNode, terraformNode + '\n        if: false'),
    inTerraform(terraformSetup, terraformSetup + '\n        continue-on-error: true'),
    inTerraform(policyEvidenceEnv, policyEvidenceEnv + '\n          FD7A_TERRAFORM_BIN: cached-producer'),
    inTerraform(policyRetention, policyRetention.replace('if: always()', 'if: success()')),
    inTerraform(policyRetention, policyRetention.replace('if-no-files-found: error', 'if-no-files-found: warn')),
    inTerraform(policyRetention, policyRetention.replace('/fd7a-policy-*/', '/cached-policy/')),
    inTerraform(policyRetention, policyRetention.replace('retention-days: 7', 'retention-days: 1')),
    inTerraform('    timeout-minutes: 15\n    steps:\n', '    timeout-minutes: 30\n    steps:\n'),
  ];
  const move = '      ' + terraformNode + '\n';
  variants.push(inTerraform(move, '').replace('      - run: ' + terraformCommands[0] + '\n', '      - run: ' + terraformCommands[0] + '\n' + move));
  for (const changed of variants) { assert.notEqual(changed, workflow); assert.ok(terraformJobProblems(changed).length > 0); }
});

test('every actual Terraform and Node producer command preserves a native nonzero exit', () => {
  for (const command of runSteps(workflow, 'terraform')) for (const status of [0, 17]) {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `terraform() { return ${status}; }; node() { return ${status}; };\n${command}`], { encoding: 'utf8' });
    assert.equal(result.status, status, command + ': ' + result.stderr);
  }
});

const passingPolicySummary = { type: 'test_summary', test_summary: { status: 'pass', passed: 1, failed: 0, errored: 0, skipped: 0 } };
const policyPlanEvent = { type: 'test_plan', '@testfile': 'tests/policy.tftest.hcl', '@testrun': 'policy_probe_fixture', test_plan: { resource_changes: [] } };
const policyRefusals = [
  ['nonzero native producer', '', 17, /mocked Terraform producer failed/],
  ['skipped native fixture', JSON.stringify({ ...passingPolicySummary, test_summary: { ...passingPolicySummary.test_summary, skipped: 1 } }) + '\n', 0, /expected one passing mocked plan/],
  ['missing native plan', JSON.stringify(passingPolicySummary) + '\n', 0, /require exactly one fresh plan/],
  ['duplicate native plans', [policyPlanEvent, policyPlanEvent, passingPolicySummary].map(v => JSON.stringify(v)).join('\n') + '\n', 0, /require exactly one fresh plan/],
  ['malformed native output', 'not-json\n', 0, /SyntaxError/],
  ['stale prior producer output', '', 0, /expected one passing mocked plan/],
  ['missing executable', '', null, /mocked Terraform producer failed/, { missing: true, error: 'ENOENT' }],
  ['terminated producer', '', null, /mocked Terraform producer failed/, { body: "process.kill(process.pid, 'SIGTERM');", signal: 'SIGTERM' }],
  ['empty output', '', 0, /expected one passing mocked plan/, { body: 'process.exit(0);' }],
  ['timed-out producer', '', null, /mocked Terraform producer failed/, { body: 'setTimeout(() => {}, 10000);', timeout: true, signal: 'SIGTERM', error: 'ETIMEDOUT' }],
  ['timed-out producer exiting zero', JSON.stringify(passingPolicySummary) + '\n', 0, /mocked Terraform producer failed \(ETIMEDOUT\)/, {
    body: "process.on('SIGTERM', () => process.exit(0)); process.stdout.write(process.env.FD7A_CONTROL_OUTPUT); setTimeout(() => process.exit(0), 3000);",
    timeout: true, timeoutMs: 500, error: 'ETIMEDOUT',
  }],
];
for (const [label, output, status, reason, options = {}] of policyRefusals) {
  test(`actual policy entry refuses ${label}`, () => {
    const parent = process.env.FD7A_CI_CONTROL_EVIDENCE_DIR ?? tmpdir();
    const dir = mkdtempSync(join(parent, 'ci-fd7a-policy-'));
    const binary = join(dir, 'terraform-fixture');
    if (!options.missing) {
      const body = options.body ?? 'process.stdout.write(process.env.FD7A_CONTROL_OUTPUT); process.exit(Number(process.env.FD7A_CONTROL_STATUS));';
      writeFileSync(binary, '#!/usr/bin/env node\n' + body + '\n', { mode: 0o700 });
      chmodSync(binary, 0o700);
    }
    const stale = join(dir, 'fd7a-policy-prior');
    if (label.includes('stale')) {
      // A named old fixture must not stand in for the current producer; only this owned directory is seeded.
      mkdirSync(stale);
      writeFileSync(join(stale, 'terraform.stdout.jsonl'), [policyPlanEvent, passingPolicySummary].map(v => JSON.stringify(v)).join('\n') + '\n');
    }
    const old = readdirSync(dir);
    const args = ['--test', new URL('../../infrastructure/terraform-state/policy.test.mjs', import.meta.url).pathname];
    if (options.timeout) {
      // Shorten only this nested test's spawn deadline; the real producer keeps its 120-second timeout.
      const preload = join(dir, 'bounded-timeout.mjs');
      writeFileSync(preload, "import cp from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nconst original = cp.spawnSync;\ncp.spawnSync = (binary, args, options) => original(binary, args, { ...options, timeout: " + (options.timeoutMs ?? 150) + " });\nsyncBuiltinESMExports();\n", { mode: 0o600 });
      args.unshift('--import', preload);
    }
    const childEnv = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH, FD7A_TERRAFORM_BIN: binary, FD7A_TEST_EVIDENCE_DIR: dir, FD7A_CONTROL_OUTPUT: output, FD7A_CONTROL_STATUS: String(status) };
    // A nested --test launch must execute, rather than inherit the parent's child-runner context.
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024, env: childEnv });
    // Retain the complete finite synthetic producer evidence before inspecting the expected refusal.
    writeFileSync(join(dir, 'control.stdout'), result.stdout ?? '', { mode: 0o600 });
    writeFileSync(join(dir, 'control.stderr'), result.stderr ?? '', { mode: 0o600 });
    writeFileSync(join(dir, 'control.exit.json'), JSON.stringify({ args, status: result.status, signal: result.signal, error: result.error?.code ?? null }), { mode: 0o600 });
    console.log('FD7a refusal control evidence: ' + dir);
    assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, reason);
    const fresh = readdirSync(dir).filter(name => name.startsWith('fd7a-policy-') && !old.includes(name)); assert.equal(fresh.length, 1);
    const receipt = JSON.parse(readFileSync(join(dir, fresh[0], 'exit.json'), 'utf8'));
    assert.equal(receipt.binary, binary); assert.equal(receipt.status, status); assert.equal(receipt.signal, options.signal ?? null); assert.equal(receipt.error, options.error ?? null);
    assert.deepEqual(receipt.args, ['test', '-filter=tests/policy.tftest.hcl', '-json', '-verbose']);
    assert.equal(readFileSync(join(dir, fresh[0], 'terraform.stdout.jsonl'), 'utf8'), output);
    if (label.includes('stale')) assert.equal(readFileSync(join(stale, 'terraform.stdout.jsonl'), 'utf8'), [policyPlanEvent, passingPolicySummary].map(v => JSON.stringify(v)).join('\n') + '\n');
  });
}
