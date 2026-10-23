import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { budgetFromRun, budgetMs, initialize, loadBudget, remainingMs, root, runScript } from './service-budget.mjs';
import { collect, finish, metricFiles, parseSummary, profiles, runProducer, validateMetric, validateNeeds } from './service-evidence.mjs';
import { expectedProfiles, profilesFromEnv } from './service-profiles.mjs';
import { verifyAllProfiles } from './verify-recovery-metrics.mjs';
import { verifyApplicationProfiles } from './verify-application-recovery.mjs';
import { internalJobs, jobOf, serviceLayoutProblems } from './service-layout.mjs';
import { recoveryMetricControl, applicationMetricControl } from './fixtures/recovery.mjs';
import { catalogueMetricControl } from './fixtures/catalogue.mjs';

const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const identity = { repository: 'owner/repo', runId: '100', attempt: '1', headSha: 'a'.repeat(40), checkout: 'b'.repeat(40) };
const needs = () => Object.fromEntries(Object.values(profiles).map(job => [job, { result: 'success', outputs: {} }]));
const backendLog = 'PASS test/control.spec.ts (1 s)\nTest Suites: 1 skipped, 1 passed, 2 total\nTests: 2 skipped, 3 passed, 5 total\n';
const workerLog = ' ✓ test/control.test.ts (3 tests) 100ms\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n';
const json = (file, value) => writeFileSync(file, JSON.stringify(value) + '\n');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const reducedNeeds = (postgres = 'false') => ({ ...needs(), 'service-postgres': { result: 'skipped', outputs: {} }, changes: { result: 'success', outputs: { postgres } } });
function fixture(t, serviceNeeds = needs(), profileList = Object.keys(profiles)) {
  const directory = mkdtempSync(join(tmpdir(), 'service-isolation-'));
  // Only generated synthetic fixtures are removed; no repository or service data lives here.
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'checkout'); mkdirSync(cwd);
  const startedMs = Date.now() - 5000;
  const budget = { format: 1, ...identity, startedMs, deadlineMs: startedMs + budgetMs };
  const env = { ...process.env, RUNNER_TEMP: directory, GITHUB_REPOSITORY: identity.repository, GITHUB_RUN_ID: identity.runId,
    GITHUB_RUN_ATTEMPT: identity.attempt, SERVICE_HEAD_SHA: identity.headSha, GITHUB_SHA: identity.checkout, SERVICE_NEEDS: JSON.stringify(serviceNeeds) };
  delete env.TELESPHOROS_WORKSPACE_PREPARED;
  json(join(directory, 'service-budget.json'), budget);
  const timing = { format: 1, phase: 'shared-library-build', libraries: ['shared-types', 'cpic-schema', 'fake-idp', 'jobs'], durationMs: 42, exitCode: 0, nodeVersion: '22.22.0' };
  json(join(directory, 'service-test-prerequisites.json'), timing);
  const options = { env, cwd };
  const producer = async (profile, mutation = () => {}) => runProducer(profile, 'synthetic producer', { ...options, execute: async () => {
    writeFileSync(join(cwd, profile === 'worker' ? 'tier-worker.log' : { memory: 'tier1.log', postgres: 'tier2.log', 'postgres-s3': 'tier3.log' }[profile]), profile === 'worker' ? workerLog : backendLog);
    if (profile !== 'worker') {
      const target = join(cwd, 'apps/backend/test-results'); mkdirSync(target, { recursive: true });
      for (const [i, name] of metricFiles(profile).entries()) {
        const value = [catalogueMetricControl, recoveryMetricControl, applicationMetricControl][i](); value.runtime.gitHead = identity.checkout;
        json(join(target, name), value);
      }
    }
    return mutation(profile) ?? 0;
  } });
  const download = async () => {
    const directory = join(env.RUNNER_TEMP, 'service-profiles'); mkdirSync(directory);
    for (const profile of profileList) {
      assert.equal(await producer(profile), 0);
      cpSync(join(env.RUNNER_TEMP, 'service-profile-' + profile), join(directory, `service-profile-${profile}-1`), { recursive: true });
    }
    rmSync(join(cwd, 'apps/backend/test-results'), { recursive: true });
    return directory;
  };
  return { directory, cwd, budget, env, options, producer, download };
}

test('all complete service profiles have isolated jobs feeding the required joining gate', () => {
  assert.deepEqual(serviceLayoutProblems(workflow), []);
});
test('layout controls reject orphaned, optional, swallowed, incomplete or cross-run profiles', () => {
  const gate = jobOf(workflow, 'database-and-storage');
  const commands = ['service-evidence.mjs dependencies', 'service-evidence.mjs collect', 'service-evidence.mjs finish', 'verify-recovery-metrics.mjs', 'verify-application-recovery.mjs', 'service-budget.mjs check'];
  const mutations = [
    workflow.replace('needs: [service-memory, service-postgres, service-postgres-s3, changes]', 'needs: [service-memory, service-postgres, changes]'),
    workflow.replace('needs: [service-memory, service-postgres, service-postgres-s3, changes]', 'needs: [service-memory, service-postgres, service-postgres-s3]'),
    workflow.replace(gate, gate.replace('    if: always() && !(', '    if: success() && !(')),
    workflow.replace(gate, gate.replace("needs.service-postgres.result == 'skipped'", "needs.service-postgres.result != 'x'")),
    workflow.replace('pattern: service-profile-*-${{ github.run_attempt }}', 'pattern: service-profile-*'),
    workflow.replace('merge-multiple: false', 'merge-multiple: true'),
    workflow.replace('digest-mismatch: error', 'digest-mismatch: warn'),
    workflow.replace('          merge-multiple: false', '          run-id: 99\n          merge-multiple: false'),
    ...commands.flatMap(command => [workflow.replace(gate, gate.replace('run: node .github/ci/' + command, 'if: false\n        run: node .github/ci/' + command)),
      workflow.replace(gate, gate.replace('run: node .github/ci/' + command, 'run: node .github/ci/' + command + ' || true #'))]),
    ...internalJobs.flatMap(key => {
      const job = jobOf(workflow, key);
      return [workflow.replace(job, job.replace('    runs-on:', '    if: false\n    runs-on:')),
        workflow.replace(job, job.replace('    runs-on:', '    needs: verify\n    runs-on:')),
        workflow.replace(job, job.replace('timeout-minutes: 30', 'timeout-minutes: 31')),
        workflow.replace(job, job.replace('image: postgres:16', 'image: postgres:17')),
        workflow.replace(job, job.replace('        run: |', '        continue-on-error: true\n        run: |')),
        workflow.replace(job, job.replace('--filter @telesphoros/backend test', '--filter @telesphoros/backend test --testPathPattern=one')),
        workflow.replace(job, job.replace('service-budget.mjs check', 'service-budget.mjs check || true'))];
    }),
  ];
  for (const [index, mutation] of mutations.entries()) { assert.notEqual(mutation, workflow); assert.ok(serviceLayoutProblems(mutation).length > 0, `mutation ${index}`); }
});

test('all service jobs use a single fixed run-attempt deadline including queue and setup time', () => {
  const startedMs = Date.parse('2026-10-16T12:00:00Z');
  const run = { id: 100, run_attempt: 1, head_sha: identity.headSha, run_started_at: '2026-10-16T12:00:00Z', repository: { full_name: 'owner/repo' } };
  const budget = budgetFromRun(run, identity, startedMs + 1000);
  assert.equal(budget.deadlineMs, startedMs + budgetMs);
  assert.equal(remainingMs(budget, startedMs + 20 * 60_000), 10 * 60_000);
  assert.equal(budgetFromRun(run, identity, startedMs + 25 * 60_000).deadlineMs, budget.deadlineMs);
  for (const now of [startedMs - 1, budget.deadlineMs, budget.deadlineMs + 1]) assert.throws(() => remainingMs(budget, now));
  for (const changed of [{ ...budget, deadlineMs: budget.deadlineMs + 1 }, { ...budget, extra: true }, { ...budget, runId: '0' }]) assert.throws(() => remainingMs(changed, startedMs));
  for (const change of [{ id: 101 }, { run_attempt: 2 }, { head_sha: 'c'.repeat(40) }, { repository: { full_name: 'foreign/repo' } }, { run_started_at: 'invalid' }]) assert.throws(() => budgetFromRun({ ...run, ...change }, identity, startedMs));
});
test('the clock API identity is checked once per job; failures cannot reset or invent a clock', async t => {
  const f = fixture(t);
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const start = Math.floor(Date.now() / 1000) * 1000 - 5000;
  const env = { ...f.env, GITHUB_SHA: checkout, GH_TOKEN: 'PRIVATE_CLOCK_TOKEN', GITHUB_API_URL: 'https://api.github.com', GITHUB_OUTPUT: join(f.directory, 'outputs') };
  const run = { id: 100, run_attempt: 1, head_sha: identity.headSha, run_started_at: new Date(start).toISOString().replace('.000Z', 'Z'), repository: { full_name: identity.repository } };
  rmSync(join(f.directory, 'service-budget.json'));
  let calls = 0;
  const request = async (url, options) => {
    calls++; assert.equal(url, 'https://api.github.com/repos/owner/repo/actions/runs/100/attempts/1');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer PRIVATE_CLOCK_TOKEN');
    return { ok: true, json: async () => run };
  };
  assert.equal((await initialize(env, request)).deadlineMs, start + budgetMs);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /^minutes=30\n$/);
  assert.doesNotMatch(readFileSync(join(f.directory, 'service-budget.json'), 'utf8'), /PRIVATE_CLOCK_TOKEN/);
  await assert.rejects(() => initialize(env, request)); assert.equal(calls, 2);
  assert.throws(() => loadBudget({ ...env, GITHUB_RUN_ATTEMPT: '2' }));
  assert.throws(() => loadBudget({ ...env, GITHUB_SHA: identity.checkout }));
  for (const override of [{ GITHUB_API_URL: 'https://foreign.invalid' }, { GH_TOKEN: '' }, { GITHUB_SHA: identity.checkout }, { GITHUB_OUTPUT: 'relative' }]) await assert.rejects(() => initialize({ ...env, ...override }, request));
  rmSync(join(f.directory, 'service-budget.json'));
  await assert.rejects(() => initialize(env, async () => ({ ok: false })));
  assert.equal(existsSync(join(f.directory, 'service-budget.json')), false);
});

test('the actual shell wrapper preserves native failure, pipefail, signals and spawn failures', async t => {
  const f = fixture(t);
  assert.equal(await runScript('exit 0', f.budget), 0);
  assert.equal(await runScript('exit 17', f.budget), 17);
  assert.equal(await runScript('(exit 17) | tee /dev/null', f.budget), 17);
  assert.equal(await runScript('kill -TERM $$', f.budget), 1);
  assert.equal(await runScript('exit 0', f.budget, { env: { PATH: join(f.directory, 'missing') } }), 1);
  await assert.rejects(() => runScript('', f.budget));
});
test('deadline expiry kills descendants that ignore TERM instead of leaving a live producer', async t => {
  const f = fixture(t); const marker = join(f.directory, 'escaped');
  const deadlineMs = Date.now() + 150;
  const budget = { ...f.budget, startedMs: deadlineMs - budgetMs, deadlineMs };
  const script = `(trap '' TERM; sleep 1; touch ${quote(marker)}) &\nwait`;
  assert.equal(await runScript(script, budget), 124);
  await new Promise(r => setTimeout(r, 550));
  assert.equal(existsSync(marker), false);
});
test('a signalled CLI fails and kills its child process group without printing environment values', async t => {
  const f = fixture(t); const marker = join(f.directory, 'escaped'); const ready = join(f.directory, 'ready');
  const child = spawn(process.execPath, [join(root, '.github/ci/service-budget.mjs'), 'run'], { env: { ...f.env, PRIVATE_SENTINEL: 'PRIVATE_DATA' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  child.stdin.end(`touch ${quote(ready)}; (trap '' TERM; sleep 1; touch ${quote(marker)}) &\nwait`);
  const result = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(existsSync(ready)); child.kill('SIGTERM');
  assert.deepEqual(await result, { code: 1, signal: null });
  await new Promise(r => setTimeout(r, 550)); assert.equal(existsSync(marker), false); assert.doesNotMatch(output, /PRIVATE_DATA/);
});

test('summaries require final counters and a unique PASS record for every completed suite', () => {
  assert.equal(parseSummary(backendLog).tests.passed, 3); assert.equal(parseSummary(workerLog, true).tests.passed, 3);
  // The public repository has no report-reader engine: its announcement is a different marker and must not be refused, while NOT RUNNING stays refused.
  assert.equal(parseSummary(backendLog + '\n[jest] ENGINE ABSENT: skipping 21 specs that need the report-reader engine (list in test/helpers/reader-engine-specs.json)\n').tests.passed, 3);
  for (const log of ['', backendLog.replace('Test Suites:', 'Interrupted:'), backendLog + backendLog, backendLog + '[jest] NOT RUNNING',
    backendLog.replace('3 passed', '3 failed'), backendLog.replace('2 total', '3 total'), backendLog.replace('PASS', 'FAIL'), backendLog.replace('test/control', '../control'),
    backendLog.replace('1 passed, 2 total', '2 passed, 3 total')]) assert.throws(() => parseSummary(log));
  for (const log of ['', workerLog.replace('Test Files', 'Interrupted'), workerLog + 'NOT RUNNING', workerLog.replace('✓', '×')]) assert.throws(() => parseSummary(log, true));
});
test('strict per-profile evidence preserves existing validators and rejects privacy, runtime and control drift', () => {
  for (const [family, build] of [['evidence-catalogue', catalogueMetricControl], ['independent-recovery', recoveryMetricControl], ['application-recovery', applicationMetricControl]]) {
    const value = build(); value.runtime.gitHead = identity.checkout; assert.doesNotThrow(() => validateMetric(value, family, identity.checkout));
    for (const mutation of [v => { v.raw = 'PRIVATE_DATA'; }, v => { v.runtime.gitHead = identity.headSha; }, v => { v.runtime.node = 'v24.0.0'; },
      v => { v.controls[0].passed = false; }, v => { v.controls[0].url = 'PRIVATE_DATA'; }, v => { v.controls[1].name = v.controls[0].name; },
      v => { v.measurements[0].tenantId = 'PRIVATE_DATA'; }]) {
      const changed = structuredClone(value); mutation(changed); assert.throws(() => validateMetric(changed, family, identity.checkout));
    }
  }
});
test('producer seals all metrics only after the whole profile completes, and retains intentional skip counters', async t => {
  const f = fixture(t); assert.equal(await f.producer('memory'), 0);
  const value = JSON.parse(readFileSync(join(f.directory, 'service-profile-memory/completion.json'), 'utf8'));
  assert.equal(value.summary.suites.skipped, 1); assert.equal(value.summary.tests.skipped, 2); assert.equal(Object.keys(value.hashes).length, 4);
  assert.deepEqual(value.budget, f.budget);
  await assert.rejects(() => f.producer('memory')); // no reused producer invocation or stale completion
});
test('a real producer failure behind tee remains exit 17 and cannot leave completion evidence', async t => {
  const f = fixture(t);
  assert.equal(await runProducer('memory', '(exit 17) 2>&1 | tee tier1.log', f.options), 17);
  assert.equal(existsSync(join(f.directory, 'service-profile-memory/completion.json')), false);
});
test('a native child writes a complete profile and its parent seals only fresh evidence', async t => {
  const f = fixture(t);
  const target = join(f.cwd, 'apps/backend/test-results'); mkdirSync(target, { recursive: true });
  const records = [catalogueMetricControl(), recoveryMetricControl(), applicationMetricControl()];
  for (const value of records) value.runtime.gitHead = identity.checkout;
  const script = `const fs = require('node:fs');\n` + records.map((v, i) =>
    `fs.writeFileSync(${JSON.stringify(join(target, metricFiles('memory')[i]))}, ${JSON.stringify(JSON.stringify(v))});`).join('\n')
    + `\nprocess.stdout.write(${JSON.stringify(backendLog)});`;
  const child = join(f.directory, 'producer.cjs'); writeFileSync(child, script);
  assert.equal(await runProducer('memory', `${quote(process.execPath)} ${quote(child)} 2>&1 | tee tier1.log`, f.options), 0);
  assert.ok(existsSync(join(f.directory, 'service-profile-memory/completion.json')));
});
test('a profile returning zero after its shared deadline cannot create completion evidence', async t => {
  const f = fixture(t); let current = Date.now();
  await assert.rejects(() => runProducer('memory', 'synthetic', { ...f.options, now: () => current,
    execute: async () => { current = f.budget.deadlineMs; return 0; } }));
  assert.equal(existsSync(join(f.directory, 'service-profile-memory/completion.json')), false);
});
test('early metrics, stale metrics, empty logs, missing services and write errors cannot seal a profile', async t => {
  for (const mutation of [
    f => writeFileSync(join(f.cwd, 'tier1.log'), ''),
    f => writeFileSync(join(f.cwd, 'tier1.log'), backendLog + '[jest] NOT RUNNING'),
    f => rmSync(join(f.cwd, 'apps/backend/test-results/application-recovery-memory.json')),
    f => utimesSync(join(f.cwd, 'apps/backend/test-results/independent-recovery-memory.json'), 0, 0),
    f => json(join(f.cwd, 'apps/backend/test-results/evidence-catalogue-memory.json'), { status: 'passed' }),
    f => mkdirSync(join(f.directory, 'service-profile-memory/completion.json')),
  ]) {
    const f = fixture(t); await assert.rejects(() => f.producer('memory', () => { mutation(f); }));
    const completion = join(f.directory, 'service-profile-memory/completion.json');
    assert.ok(!existsSync(completion) || readdirSync(completion).length === 0);
  }
  const f = fixture(t); symlinkSync(f.cwd, join(f.directory, 'service-profile-memory')); await assert.rejects(() => f.producer('memory'));
});

test('the joining gate refuses every non-success dependency and missing or extra dependencies', () => {
  assert.doesNotThrow(() => validateNeeds(needs()));
  for (const job of Object.values(profiles)) for (const result of ['failure', 'cancelled', 'skipped', '', undefined]) {
    const value = needs(); value[job].result = result; assert.throws(() => validateNeeds(value));
  }
  for (const change of [v => { delete v['service-postgres']; }, v => { v.unknown = { result: 'success' }; }]) { const value = needs(); change(value); assert.throws(() => validateNeeds(value)); }
});
test('same-run, same-attempt, exact-checkout bundles join all nine metrics and the whole worker profile', async t => {
  const f = fixture(t); await f.download(); collect(f.options);
  assert.equal(readdirSync(join(f.cwd, 'apps/backend/test-results')).length, 9);
  assert.throws(() => finish(f.options));
  assert.equal(await f.producer('worker'), 0); assert.doesNotThrow(() => finish(f.options));
  assert.throws(() => collect(f.options)); // existing metrics never count as a fresh transfer
  const metric = join(f.cwd, 'apps/backend/test-results/evidence-catalogue-memory.json');
  const original = readFileSync(metric); writeFileSync(metric, original + '\n'); assert.throws(() => finish(f.options));
});
test('artifacts alone cannot satisfy the join after a failed, cancelled or skipped complete profile', async t => {
  const f = fixture(t); await f.download();
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const value = needs(); value['service-postgres-s3'].result = result;
    assert.throws(() => collect({ ...f.options, env: { ...f.env, SERVICE_NEEDS: JSON.stringify(value) } }));
    assert.equal(existsSync(join(f.cwd, 'apps/backend/test-results')), false);
  }
});
test('collection refuses missing, extra, altered, unbound, incomplete and previous-attempt evidence before copying', async t => {
  const cases = [
    (f, d) => rmSync(join(d, 'service-profile-memory-1'), { recursive: true }),
    (f, d) => mkdirSync(join(d, 'service-profile-memory-2')),
    (f, d) => writeFileSync(join(d, 'service-profile-memory-1/unexpected'), ''),
    (f, d) => writeFileSync(join(d, 'service-profile-memory-1/evidence-catalogue-memory.json'), '{}'),
    (f, d) => rmSync(join(d, 'service-profile-postgres-s3-1/completion.json')),
    ...['runId', 'attempt', 'checkout', 'headSha', 'repository', 'startedMs', 'deadlineMs'].map(key => (f, d) => {
      const file = join(d, 'service-profile-memory-1/completion.json'); const value = JSON.parse(readFileSync(file)); value.budget[key] = 'foreign'; json(file, value);
    }),
    (f, d) => { const file = join(d, 'service-profile-memory-1/completion.json'); const value = JSON.parse(readFileSync(file)); value.summary.suites.passed++; json(file, value); },
    (f, d) => { const file = join(d, 'service-profile-memory-1/completion.json'); const value = JSON.parse(readFileSync(file)); value.finishedMs = f.budget.deadlineMs; json(file, value); },
    (f, d) => { const file = join(d, 'service-profile-memory-1/completion.json'); const value = JSON.parse(readFileSync(file)); value.hashes = {}; json(file, value); },
    (f, d) => { rmSync(join(d, 'service-profile-memory-1'), { recursive: true }); symlinkSync(f.cwd, join(d, 'service-profile-memory-1')); },
  ];
  for (const mutate of cases) {
    const f = fixture(t); const directory = await f.download(); mutate(f, directory);
    assert.throws(() => collect(f.options)); assert.equal(existsSync(join(f.cwd, 'apps/backend/test-results')), false);
  }
});
test('expired collection or final worker acceptance cannot obtain a new 30-minute window', async t => {
  const f = fixture(t); await f.download();
  assert.throws(() => collect({ ...f.options, now: () => f.budget.deadlineMs }));
  collect(f.options); assert.equal(await f.producer('worker'), 0);
  assert.throws(() => finish({ ...f.options, now: () => f.budget.deadlineMs }));
  const completion = join(f.directory, 'service-worker/completion.json');
  const value = JSON.parse(readFileSync(completion)); value.summary.tests.failed = 1; json(completion, value);
  assert.throws(() => finish(f.options));
});
test('CLI validation failures are generic and never print rejected environment data', t => {
  const f = fixture(t);
  for (const script of ['service-budget.mjs', 'service-evidence.mjs']) {
    const result = spawnSync(process.execPath, [join(root, '.github/ci', script), 'unexpected'], { env: { ...f.env, PRIVATE: 'PRIVATE_DATA' }, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /^Service (?:budget|evidence) command failed\.\n$/); assert.doesNotMatch(result.stderr, /PRIVATE_DATA/);
  }
});

test('the joining gate expects exactly the profiles the scope names: two on a pull request, three in the nightly, three on any doubt', () => {
  const three = { ...needs(), changes: { result: 'success', outputs: { postgres: 'true' } } };
  assert.doesNotThrow(() => validateNeeds(needs()), 'the old three-key shape still expects all three');
  assert.doesNotThrow(() => validateNeeds(three));
  assert.doesNotThrow(() => validateNeeds(reducedNeeds()));
  assert.deepEqual(expectedProfiles(reducedNeeds()), ['memory', 'postgres-s3']);
  for (const [label, value] of Object.entries({
    'the standalone profile ran although it was not expected': { ...reducedNeeds(), 'service-postgres': { result: 'success', outputs: {} } },
    'the standalone profile was skipped although it was expected': { ...three, 'service-postgres': { result: 'skipped', outputs: {} } },
    'changes failed and the standalone profile was skipped': { ...reducedNeeds(), changes: { result: 'failure', outputs: { postgres: 'false' } } },
    'changes was skipped': { ...reducedNeeds(), changes: { result: 'skipped', outputs: { postgres: 'false' } } },
    'changes gave no output': { ...reducedNeeds(), changes: { result: 'success', outputs: {} } },
    'changes gave a near miss': { ...reducedNeeds(), changes: { result: 'success', outputs: { postgres: 'False' } } },
    'changes gave nothing at all': { ...reducedNeeds(), changes: {} },
    'memory skipped in the reduced set': { ...reducedNeeds(), 'service-memory': { result: 'skipped', outputs: {} } },
    'PostgreSQL + S3 skipped in the reduced set': { ...reducedNeeds(), 'service-postgres-s3': { result: 'skipped', outputs: {} } },
    'memory failed in the reduced set': { ...reducedNeeds(), 'service-memory': { result: 'failure', outputs: {} } },
    'an unknown dependency': { ...reducedNeeds(), unknown: { result: 'success' } },
  })) assert.throws(() => validateNeeds(value), label);
  for (const bad of [null, undefined, [], 'x', 3]) assert.throws(() => validateNeeds(bad));
  for (const unnarrowed of [needs(), three, { ...needs(), changes: { result: 'failure', outputs: { postgres: 'false' } } }]) assert.deepEqual(expectedProfiles(unnarrowed), ['memory', 'postgres', 'postgres-s3']);
});

test('two-profile evidence joins six metrics and the worker; evidence that does not match the expected set is refused before copying', async t => {
  const f = fixture(t, reducedNeeds(), ['memory', 'postgres-s3']); await f.download(); collect(f.options);
  assert.equal(readdirSync(join(f.cwd, 'apps/backend/test-results')).length, 6);
  assert.throws(() => finish(f.options));
  assert.equal(await f.producer('worker'), 0); assert.doesNotThrow(() => finish(f.options));
  // An unexpected third bundle, or a missing expected one, never joins.
  const extra = fixture(t, reducedNeeds()); await extra.download();
  assert.throws(() => collect(extra.options)); assert.equal(existsSync(join(extra.cwd, 'apps/backend/test-results')), false);
  const missing = fixture(t, needs(), ['memory', 'postgres-s3']); await missing.download();
  assert.throws(() => collect(missing.options)); assert.equal(existsSync(join(missing.cwd, 'apps/backend/test-results')), false);
  // The recovery validators take the same list: all three by default, two when told.
  const four = fixture(t, reducedNeeds(), ['memory', 'postgres-s3']); await four.download(); collect(four.options);
  assert.doesNotThrow(() => verifyAllProfiles(join(four.cwd, 'apps/backend/test-results'), identity.checkout, ['memory', 'postgres-s3']));
  assert.throws(() => verifyAllProfiles(join(four.cwd, 'apps/backend/test-results'), identity.checkout));
  assert.doesNotThrow(() => verifyApplicationProfiles(join(four.cwd, 'apps/backend/test-results'), identity.checkout, ['memory', 'postgres-s3']));
  assert.throws(() => verifyApplicationProfiles(join(four.cwd, 'apps/backend/test-results'), identity.checkout));
});

test('the recovery validators read the expected set from the gate environment and default to all three', () => {
  assert.deepEqual(profilesFromEnv({}), ['memory', 'postgres', 'postgres-s3']);
  assert.deepEqual(profilesFromEnv({ SERVICE_NEEDS: JSON.stringify(reducedNeeds()) }), ['memory', 'postgres-s3']);
  assert.deepEqual(profilesFromEnv({ SERVICE_NEEDS: JSON.stringify(needs()) }), ['memory', 'postgres', 'postgres-s3']);
  assert.throws(() => profilesFromEnv({ SERVICE_NEEDS: 'not json' }));
});
