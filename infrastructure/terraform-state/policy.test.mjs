import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { evaluate, policyCases, reviewPolicyCases, mutations } from './policy-probes.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const fixture = 'tests/policy.tftest.hcl';
const evidenceParent = process.env.FD7A_TEST_EVIDENCE_DIR ?? tmpdir();
// Unique directory prevents stale producer output from satisfying a later test run.
const evidence = mkdtempSync(join(resolve(evidenceParent), 'fd7a-policy-'));
const stdout = openSync(join(evidence, 'terraform.stdout.jsonl'), 'wx', 0o600);
const stderr = openSync(join(evidence, 'terraform.stderr'), 'wx', 0o600);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith('AWS_') && !name.startsWith('TF_CLI_ARGS') && !name.startsWith('TF_VAR_')));
Object.assign(env, {
  AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true', TF_IN_AUTOMATION: 'true', TF_INPUT: '0',
  TF_CLI_CONFIG_FILE: '/dev/null',
});
const binary = process.env.FD7A_TERRAFORM_BIN ?? 'terraform';
const args = ['test', `-filter=${fixture}`, '-json', '-verbose'];
let result;
try {
  result = spawnSync(binary, args, {
    cwd: root, env, stdio: ['ignore', stdout, stderr], timeout: 120_000,
  });
} finally {
  closeSync(stdout);
  closeSync(stderr);
}
// Retain complete native stdout/stderr and producer status before parsing or summarizing.
writeFileSync(join(evidence, 'exit.json'), JSON.stringify({
  binary, args, cwd: root, status: result.status, signal: result.signal,
  error: result.error?.code ?? null,
}, null, 2), { mode: 0o600 });
assert.ok(result.status === 0 && result.signal === null && result.error === undefined,
  `mocked Terraform producer failed (${result.error?.code ?? result.signal}); evidence: ${evidence}`);

const plans = [];
let summary;
for await (const line of createInterface({ input: createReadStream(join(evidence, 'terraform.stdout.jsonl')), crlfDelay: Infinity })) {
  const event = JSON.parse(line);
  if (event.type === 'test_plan' && event['@testfile'] === fixture && event['@testrun'] === 'policy_probe_fixture') plans.push(event.test_plan);
  if (event.type === 'test_summary') summary = event.test_summary;
}
assert.deepEqual(summary, { status: 'pass', passed: 1, failed: 0, errored: 0, skipped: 0 }, `expected one passing mocked plan; evidence: ${evidence}`);
assert.equal(plans.length, 1, 'require exactly one fresh plan, never an empty or stale policy fixture');
const resources = new Map(plans[0].resource_changes.map((r) => [r.address, r.change.after]));
const key = resources.get('aws_kms_key.state');
const policies = {
  s3: JSON.parse(resources.get('aws_s3_bucket_policy.state').policy),
  kms: JSON.parse(key.policy),
};
const cases = policyCases(key.arn);
const reviewCases = reviewPolicyCases(key.arn);
assert.equal(cases.length, 145);
assert.equal(reviewCases.length, 16);
const allCases = [...cases, ...reviewCases];
assert.equal(new Set(allCases.map((c) => c.name)).size, 161, 'every original and promoted policy case must be named separately');
assert.equal(mutations.length, 10);

for (const probe of allCases) {
  test(probe.name, () => assert.equal(evaluate(policies, probe), probe.expected));
}
for (const { name, weaken, select, changedResult } of mutations) {
  test(`mutation caught: ${name}`, () => {
    const probe = cases.find(select);
    assert.ok(probe, 'the intended challenge probe must exist');
    assert.equal(evaluate(policies, probe), probe.expected, 'baseline must pass before weakening');
    const changed = structuredClone(policies);
    weaken(changed);
    assert.notDeepEqual(changed, policies, 'the deliberate defect must actually alter the policy');
    assert.equal(evaluate(changed, probe), changedResult, 'the intended probe must observe the exact permission change');
    assert.notEqual(changedResult, probe.expected, 'the original expectation must reject the mutation');
  });
}
console.log(`Mocked policy producer evidence: ${evidence}`);
