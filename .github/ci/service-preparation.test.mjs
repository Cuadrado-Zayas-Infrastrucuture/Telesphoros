import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import workspace from '../../scripts/workspace-build/workspace.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/workspace-build/prepare-service-tests.cjs');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'service-preparation-control-'));
  // Only this test's generated fixtures are removed; the next run recreates them.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const envFile = join(dir, 'job-env');
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(envFile, '');
  const fake = join(dir, 'pnpm.cjs');
  writeFileSync(fake, [
    "const { appendFileSync } = require('node:fs');",
    "appendFileSync(process.env.CALLS, JSON.stringify({ args: process.argv.slice(2), inheritedPrepared: process.env.TELESPHOROS_WORKSPACE_PREPARED === '1' }) + '\\n');",
    "if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);",
    "else process.exit(Number(process.env.FAKE_EXIT || 0));",
  ].join('\n'));
  const launcher = join(bin, 'pnpm');
  writeFileSync(launcher, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(fake) + ' "$@"\n');
  chmodSync(launcher, 0o700);
  const env = {
    PATH: bin, CALLS: calls, GITHUB_ENV: envFile, RUNNER_TEMP: dir,
    [workspace.prepared]: '1',
    PRIVATE_SENTINEL: 'PRIVATE_VALUE_MUST_NOT_ENTER_RECEIPT',
  };
  const invoke = (overrides = {}, args = []) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8',
  });
  return {
    dir, envFile, callsFile: calls, env, invoke,
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse),
    receipt: () => JSON.parse(readFileSync(join(dir, 'service-test-prerequisites.json'), 'utf8')),
  };
}

test('service preparation ignores inherited state and supplies one producer to unchanged consumer hooks', t => {
  const f = fixture(t);
  const result = f.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [{
    args: workspace.libraries.flatMap(name => ['--filter', '@telesphoros/' + name]).concat('build'),
    inheritedPrepared: false,
  }]);
  assert.equal(readFileSync(f.envFile, 'utf8'), workspace.prepared + '=1\n');
  // Exercise the real existing hook CLI with the newly prepared child environment.
  for (const names of [['shared-types', 'cpic-schema', 'jobs'], ['shared-types'], ['jobs']]) {
    const consumer = spawnSync(process.execPath, [
      join(root, 'scripts/workspace-build/workspace.cjs'), 'prepare', ...names,
    ], { cwd: root, env: f.env, encoding: 'utf8' });
    assert.equal(consumer.status, 0, consumer.stderr);
  }
  assert.equal(f.calls().length, 1);
  assert.equal(f.receipt().exitCode, 0);
});

test('every explicit preparation rebuilds, even with a prior receipt and inherited marker', t => {
  const f = fixture(t);
  assert.equal(f.invoke().status, 0);
  assert.equal(f.invoke().status, 0);
  assert.equal(f.calls().length, 2);
  assert.ok(f.calls().every(call => !call.inheritedPrepared));
});

test('a failed prerequisite preserves its exit and never exports prepared state', t => {
  const f = fixture(t);
  const result = f.invoke({ FAKE_EXIT: '17' });
  assert.equal(result.status, 17);
  assert.equal(readFileSync(f.envFile, 'utf8'), '');
  assert.equal(f.receipt().exitCode, 17);
  assert.equal(f.calls().length, 1);
});

test('interrupted and unspawnable prerequisites fail without exporting prepared state', t => {
  for (const overrides of [{ FAKE_SIGNAL: 'SIGTERM' }, { PATH: join(tmpdir(), 'missing-service-preparation-executable') }]) {
    const f = fixture(t);
    assert.notEqual(f.invoke(overrides).status, 0);
    assert.equal(readFileSync(f.envFile, 'utf8'), '');
    assert.notEqual(f.receipt().exitCode, 0);
  }
});

test('timing receipts contain only whitelisted fixed metadata and numeric observations', t => {
  const f = fixture(t);
  const result = f.invoke();
  assert.equal(result.status, 0, result.stderr);
  const receipt = f.receipt();
  assert.deepEqual(Object.keys(receipt).sort(), ['durationMs', 'exitCode', 'format', 'libraries', 'nodeVersion', 'phase']);
  assert.deepEqual(receipt.libraries, workspace.libraries);
  assert.equal(receipt.format, 1);
  assert.equal(receipt.phase, 'shared-library-build');
  assert.equal(receipt.nodeVersion, process.versions.node);
  assert.ok(Number.isInteger(receipt.durationMs) && receipt.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(receipt) + result.stdout + result.stderr, /PRIVATE_VALUE_MUST_NOT_ENTER_RECEIPT/);
  assert.deepEqual(JSON.parse(result.stdout), receipt);
});

test('invalid job context and unexpected arguments run no producer and leak no values', t => {
  for (const overrides of [{ GITHUB_ENV: '' }, { RUNNER_TEMP: 'PRIVATE_VALUE_MUST_NOT_ENTER_RECEIPT' }]) {
    const f = fixture(t);
    const result = f.invoke(overrides);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(f.callsFile), false);
    assert.equal(readFileSync(f.envFile, 'utf8'), '');
    assert.doesNotMatch(result.stderr, /PRIVATE_VALUE_MUST_NOT_ENTER_RECEIPT/);
  }
  const f = fixture(t);
  assert.notEqual(f.invoke({}, ['unexpected']).status, 0);
  assert.equal(existsSync(f.callsFile), false);
});

test('receipt and job-environment write failures cannot report successful preparation', t => {
  const receiptFailure = fixture(t);
  mkdirSync(join(receiptFailure.dir, 'service-test-prerequisites.json'));
  const failedReceipt = receiptFailure.invoke();
  assert.notEqual(failedReceipt.status, 0);
  assert.equal(readFileSync(receiptFailure.envFile, 'utf8'), '');
  assert.equal(receiptFailure.calls().length, 1);
  assert.doesNotMatch(failedReceipt.stderr, /PRIVATE_VALUE_MUST_NOT_ENTER_RECEIPT/);

  const exportFailure = fixture(t);
  const failedExport = exportFailure.invoke({ GITHUB_ENV: join(exportFailure.dir, 'missing-parent', 'job-env') });
  assert.notEqual(failedExport.status, 0);
  // The receipt describes a successful build; the failed export still makes the command fail.
  assert.equal(exportFailure.receipt().exitCode, 0);
  assert.equal(failedExport.stdout, '');
  assert.equal(readFileSync(exportFailure.envFile, 'utf8'), '');
});

const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const preparationCommand = 'node scripts/workspace-build/prepare-service-tests.cjs';

function servicePreparationProblems(text) {
  const problems = [];
  for (const key of ['service-memory', 'service-postgres', 'service-postgres-s3']) {
    const job = text.split(new RegExp('^  ' + key + ':\\s*$', 'm'))[1]?.split(/^  [a-z][a-z0-9-]*:\s*$/m)[0] ?? '';
    const steps = job.split(/^      - /m).slice(1);
    const producers = steps.filter(s => s.includes(preparationCommand));
    if (producers.length !== 1 || /^        (?:if|continue-on-error):/m.test(producers[0] ?? '')) problems.push('one mandatory producer');
    const position = job.indexOf(preparationCommand);
    if (position < job.indexOf('pnpm install --frozen-lockfile') || position > job.indexOf('- name: "Tier ') || position < 0) problems.push('producer ordering');
    if (job.includes(workspace.prepared)) problems.push('no inherited marker override');
    const receipt = steps.find(s => s.startsWith('name: Retain shared-library build timing\n')) ?? '';
    if (!receipt.includes('if: always()') || receipt.includes('continue-on-error:')
      || !receipt.includes('path: ${{ runner.temp }}/service-test-prerequisites.json')
      || !receipt.includes('if-no-files-found: error') || !receipt.includes('retention-days: 7')) problems.push('timing receipt retention');
  }
  return problems;
}

test('each isolated profile requires preparation after install and before unchanged tier execution', () => {
  assert.deepEqual(servicePreparationProblems(workflow), []);
});

test('service CI guard rejects missing, conditional, swallowed, premature or inherited preparation', () => {
  const producer = `      - name: Prepare shared libraries for service tests
        run: |
          node .github/ci/service-budget.mjs run <<'BUDGET'
          ${preparationCommand}
          BUDGET
`;
  for (const mutated of [
    workflow.replace(producer, ''),
    workflow.replace(producer, producer.replace('        run:', '        if: false\n        run:')),
    workflow.replace(producer, producer.replace('        run:', '        continue-on-error: true\n        run:')),
    workflow.replace(producer, '').replace('      - name: Retain completed profile evidence', producer + '      - name: Retain completed profile evidence'),
    workflow.replace(producer, '').replace('    services:\n', '    services:\n' + producer),
    workflow.replace(producer, producer + '        env:\n          ' + workspace.prepared + ': "1"\n'),
    workflow.replace('          path: ${{ runner.temp }}/service-test-prerequisites.json', '          path: missing-receipt.json'),
  ]) { assert.notEqual(mutated, workflow); assert.ok(servicePreparationProblems(mutated).length > 0); }
});
