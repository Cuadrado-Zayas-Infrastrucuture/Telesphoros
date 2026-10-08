// Run with: node --test .github/ci/guard.test.mjs   (pnpm test:ci-config)
// A cheap tripwire over the CI configuration, in the spirit of infrastructure/terraform/guard.test.mjs.
// It reads text; it cannot prove what GitHub will do. It stops the quiet mistakes:
//   - an Action referenced by a movable tag instead of a commit SHA,
//   - a renamed job that silently stops being a required check,
//   - the ruleset and the workflow drifting apart,
//   - the workflow gaining write permissions or running untrusted code with secrets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const workflow = read('../workflows/ci.yml');
const ruleset = JSON.parse(read('../rulesets/main.json'));
const dependabot = read('../dependabot.yml');

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
