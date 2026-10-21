import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
test('all service action steps are covered by an armed pre-checkout deadline monitor', () => {
  for (const job of ['service-memory', 'service-postgres', 'service-postgres-s3', 'database-and-storage']) {
    const block = workflow.split(new RegExp('^  ' + job + ':\\s*$', 'm'))[1]?.split(/^  [a-z][a-z0-9-]*:\s*$/m)[0] ?? '';
    assert.match(block, /SERVICE_WATCHDOG_REQUIRED: "1"/);
    assert.ok(block.indexOf('service_deadline') < block.indexOf('uses: actions/checkout@') && block.indexOf('service_deadline') >= 0);
  }
  assert.doesNotMatch(workflow, /fromJSON\(steps\.budget\.outputs\.minutes\)/);
});
test('process supervision identifies detached descendants and excludes old or reused process identities', async () => {
  const { selectDescendants, selectNewProcesses } = await import('./service-deadline.mjs');
  const owner = { pid: 100, ppid: 1, uid: 501, start: '100', command: 'Runner.Worker' };
  const old = { pid: 110, ppid: 100, uid: 501, start: '110', command: 'old' };
  const first = new Map([[100, owner], [110, old]]);
  const detached = { pid: 120, ppid: 1, uid: 501, start: '120', command: 'node' };
  const sameTree = { pid: 130, ppid: 100, uid: 501, start: '130', command: 'node' };
  const foreign = { pid: 140, ppid: 1, uid: 0, start: '140', command: 'root-service' };
  const table = new Map([...first, [120, detached], [130, sameTree], [140, foreign]]);
  assert.deepEqual(selectNewProcesses(table, first, 501, new Set([100])).map(p => p.pid).sort(), [120, 130]);
  assert.deepEqual(selectDescendants(table, new Map([[100, owner]])).map(p => p.pid).sort(), [100, 110, 130]);
  const reused = { ...old, start: 'new' }; table.set(110, reused);
  assert.ok(selectNewProcesses(table, first, 501, new Set([100])).some(p => p.pid === 110));
});

test('first-step aliases cannot be missing, late, optional, drifted or weakened', async () => {
  const { serviceLayoutProblems, jobOf } = await import('./service-layout.mjs');
  assert.deepEqual(serviceLayoutProblems(workflow), []);
  const alterations = [
    workflow.replace('      - *service_deadline\n', ''),
    workflow.replace('      - *service_deadline\n', '      - run: true\n'),
    workflow.replace('        id: deadline\n', '        id: deadline\n        if: false\n'),
    workflow.replace('        timeout-minutes: 1\n', '        timeout-minutes: 31\n'),
    workflow.replace('SERVICE_WATCHDOG_REQUIRED: "1"', 'SERVICE_WATCHDOG_REQUIRED: "0"'),
    workflow.replace('          export const budgetMs = 30 * 60_000;', '          export const budgetMs = 31 * 60_000;'),
    workflow.replace('          SERVICE_DEADLINE\n', '          SERVICE_DEADLINE\n          exit 0\n'),
    workflow.replace("if: always() && steps.deadline.outputs.armed == 'true'", 'if: always()'),
    ...['service-postgres','service-postgres-s3','database-and-storage'].map(key => {
      const job = jobOf(workflow, key);
      return workflow.replace(job, job.replace('      - *service_deadline\n', '').replace('      - uses: pnpm/action-setup', '      - *service_deadline\n      - uses: pnpm/action-setup'));
    }),
  ].filter(v => v !== workflow);
  for (const [index, value] of alterations.entries()) assert.ok(serviceLayoutProblems(value).length, `mutation ${index} must be refused`);
});

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { bootstrap, budgetFromRun, budgetMs, hostedOwner, identityFromEnv, parseLinuxProcess, processKey, readProcess, readProcesses, reasons, remainingMs, requestBudget, signalIdentity, watchJob, validateWatchdog } from './service-deadline.mjs';
import { runScript } from './service-budget.mjs';
const quote = v => "'" + v.replaceAll("'", "'\\''") + "'";
const budget = deadlineMs => ({ format: 1, repository: 'owner/repo', runId: '100', attempt: '1', headSha: 'a'.repeat(40), checkout: 'b'.repeat(40), startedMs: deadlineMs - budgetMs, deadlineMs });
const hash = v => createHash('sha256').update(v).digest('hex');
function temporaryFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'deadline-control-'));
  // Only generated fixtures and explicitly spawned children belong to this test.
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('Synthetic fixture did not become ready.');
}
function child(t, code, options = {}) {
  // Even on an assertion failure this finite synthetic process exits itself within six seconds.
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 6000);\n' + code], { stdio: 'ignore', ...options });
  const exited = new Promise(resolve => p.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); await exited; });
  return { process: p, exited };
}

test('Linux process identities handle spaced comm fields and zombies without reading environment data', () => {
  const fields = Array.from({ length: 20 }, () => '0'); fields[0] = 'S'; fields[1] = '22'; fields[19] = '987654';
  assert.deepEqual(parseLinuxProcess('42 (reader child (test)) ' + fields.join(' '), 1001), { pid: 42, ppid: 22, uid: 1001, start: '987654', command: 'reader child (test)' });
  fields[0] = 'Z'; assert.equal(parseLinuxProcess('42 (reader) ' + fields.join(' '), 1001), null);
  assert.throws(() => parseLinuxProcess('malformed', 1001));
});
test('the process adapter verifies the current native identity', () => {
  const records = readProcesses(); const self = records.get(process.pid);
  assert.ok(self); assert.equal(self.uid, process.getuid()); assert.equal(processKey(readProcess(process.pid)), processKey(self));
});
test('the Linux /proc adapter reads actual-shaped fixture files and handles process disappearance', t => {
  const dir = temporaryFixture(t); mkdirSync(join(dir, '42'));
  const fields = Array.from({ length: 20 }, () => '0'); fields[0] = 'S'; fields[1] = '22'; fields[19] = '123456';
  writeFileSync(join(dir, '42/stat'), '42 (mutable thread title) ' + fields.join(' '));
  symlinkSync('/synthetic/Runner.Worker', join(dir, '42/exe'));
  const table = readProcesses('linux', dir);
  assert.equal(table.get(42).uid, process.getuid()); assert.equal(table.get(42).start, '123456'); assert.equal(table.get(42).command, 'Runner.Worker');
  assert.equal(readProcess(43, 'linux', dir), null); assert.throws(() => readProcess('../forbidden', 'linux', dir));
});
test('identity checks never signal a reused PID, another UID or the supervisor itself', () => {
  const original = { pid: 100, ppid: 1, uid: 501, start: '100', command: 'node' }; const calls = [];
  const kill = (...args) => calls.push(args);
  for (const value of [{ ...original, start: 'reused' }, { ...original, uid: 0 }, null]) assert.equal(signalIdentity(original, 'SIGKILL', { read: () => value, kill }), false);
  assert.equal(signalIdentity({ ...original, pid: process.pid }, 'SIGKILL', { read: () => original, kill }), false);
  assert.deepEqual(calls, []);
  assert.equal(signalIdentity(original, 'SIGTERM', { read: () => original, kill }), true); assert.deepEqual(calls, [[100, 'SIGTERM']]);
});
test('machine-wide selection is refused outside the exact hosted Linux job ancestry', () => {
  const owner = { pid: 100, ppid: 1, uid: 501, start: '100', command: 'Runner.Worker' };
  const table = new Map([[process.pid, { pid: process.pid, ppid: 100, uid: 501, start: 'self', command: 'node' }], [100, owner]]);
  const env = { RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
  assert.equal(hostedOwner(env, table, 'linux', 501), owner);
  for (const [changed, platform, uid] of [[{ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux', 501], [env, 'darwin', 501], [env, 'linux', 0], [{ ...env, RUNNER_ARCH: 'ARM64' }, 'linux', 501]]) assert.throws(() => hostedOwner(changed, table, platform, uid));
  assert.throws(() => hostedOwner(env, new Map([[process.pid, { ...table.get(process.pid), ppid: 1 }]]), 'linux', 501));
});

test('watchdog interrupts an unwrapped action and an orphaned detached child, preserving preexisting work', async t => {
  const dir = temporaryFixture(t); const ready = join(dir, 'owner-ready'); const stop = join(dir, 'owner-stopped');
  const ownerChild = child(t, `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(stop)}, 'stopped'); process.exit(1); }); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`);
  const protectedChild = child(t, 'setInterval(() => {}, 1000);');
  await waitFor(() => existsSync(ready));
  const allowed = new Set([process.pid, ownerChild.process.pid, protectedChild.process.pid]);
  // The injected table contains ONLY this fixture's explicit PIDs. No same-UID host scan can signal another app.
  const scopedRead = () => new Map([...allowed].map(pid => [pid, readProcess(pid)]).filter(([, p]) => p));
  const baseline = scopedRead(), owner = baseline.get(ownerChild.process.pid);
  const actionMarker = join(dir, 'action-completed'), orphanMarker = join(dir, 'orphan-completed'), orphanPid = join(dir, 'orphan-pid');
  const action = child(t, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(actionMarker)}, 'late'), 2200);`); allowed.add(action.process.pid);
  const launcher = child(t, `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e',${JSON.stringify("setTimeout(() => { require('node:fs').writeFileSync(" + JSON.stringify(orphanMarker) + ", 'late'); process.exit(0); }, 2200);")}],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}}); fs.writeFileSync(${JSON.stringify(orphanPid)}, String(c.pid)); c.unref(); setTimeout(() => process.exit(0), 30);`);
  allowed.add(launcher.process.pid); await waitFor(() => existsSync(orphanPid));
  const detachedPid = Number(readFileSync(orphanPid)); allowed.add(detachedPid); await launcher.exited;
  assert.ok(readProcess(detachedPid));
  const result = await watchJob({ budget: budget(Date.now() + 300), owner, baseline, uid: process.getuid(), directory: dir, read: scopedRead, shutdownGraceMs: 300 });
  assert.equal(result, 124); assert.ok(existsSync(stop)); assert.ok(readProcess(protectedChild.process.pid));
  assert.equal(readProcess(detachedPid), null); await action.exited;
  await new Promise(r => setTimeout(r, 1700));
  assert.equal(existsSync(actionMarker), false); assert.equal(existsSync(orphanMarker), false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'service-watchdog.json'))).state, 'expired');
});
test('the watchdog escalates a shutdown-resistant owner and preserves failure semantics', async t => {
  const dir = temporaryFixture(t), ready = join(dir, 'ready');
  const ownerChild = child(t, `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`); await waitFor(() => existsSync(ready));
  const read = () => new Map([process.pid, ownerChild.process.pid].map(pid => [pid, readProcess(pid)]).filter(([, p]) => p));
  const baseline = read(); const result = await watchJob({ budget: budget(Date.now() + 80), owner: baseline.get(ownerChild.process.pid), baseline, uid: process.getuid(), directory: dir, read, shutdownGraceMs: 100 });
  assert.equal(result, 124); assert.equal((await ownerChild.exited).signal, 'SIGKILL');
});
test('a completed owner disarms supervision without waiting for or resetting the deadline', async t => {
  const dir = temporaryFixture(t); const ownerChild = child(t, 'setTimeout(() => process.exit(0), 150);');
  const read = () => new Map([process.pid, ownerChild.process.pid].map(pid => [pid, readProcess(pid)]).filter(([, p]) => p));
  const baseline = read(), start = Date.now();
  assert.equal(await watchJob({ budget: budget(start + 3000), owner: baseline.get(ownerChild.process.pid), baseline, uid: process.getuid(), directory: dir, read }), 0);
  assert.ok(Date.now() - start < 1500); assert.equal(JSON.parse(readFileSync(join(dir, 'service-watchdog.json'))).state, 'stopped');
});
test('the native script wrapper kills detached minimal-environment children before returning from expiry', async t => {
  const dir = temporaryFixture(t), marker = join(dir, 'late'), pidFile = join(dir, 'pid'), script = join(dir, 'reader-shape.cjs');
  writeFileSync(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify("setTimeout(() => { require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'late'); process.exit(0); }, 1800);")}],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`);
  assert.equal(await runScript(`${quote(process.execPath)} ${quote(script)}`, budget(Date.now() + 600)), 124);
  assert.ok(existsSync(pidFile)); assert.equal(readProcess(Number(readFileSync(pidFile))), null);
  await new Promise(r => setTimeout(r, 1000)); assert.equal(existsSync(marker), false);
});
test('a required watchdog cannot be bypassed by absent, stale, failed or tampered receipts', () => {
  // Cross-platform negative control; production uses a real Runner.Worker owner on hosted Linux.
  const env = { RUNNER_TEMP: tmpdir() }; assert.throws(() => validateWatchdog(env, budget(Date.now() + 1000)));
});

function watchdogFixture(t) {
  const dir = temporaryFixture(t), now = Date.now(), b = budget(now + 10000), uid = process.getuid();
  const owner = { pid: 111111, ppid: 1, uid, start: 'owner-start', command: 'Runner.Worker' };
  const monitor = { pid: 222222, ppid: 1, uid, start: 'monitor-start', command: 'node' };
  const receipt = { format: 1, state: 'armed', pid: monitor.pid, start: monitor.start, owner, budgetHash: hash(JSON.stringify(b)), sourceHash: hash(readFileSync(new URL('./service-deadline.mjs', import.meta.url))), heartbeatMs: now };
  const file = join(dir, 'service-watchdog.json'), env = { RUNNER_TEMP: dir };
  const read = pid => pid === owner.pid ? owner : pid === monitor.pid ? monitor : null;
  return { dir, now, b, uid, owner, monitor, receipt, file, env, read };
}
function refusal(fn) {
  try { fn(); } catch (error) { return error; }
  return assert.fail('Expected a refusal.');
}
test('watchdog receipts bind the live owner, process identity, source, clock and heartbeat, each with its own reason code', t => {
  const { now, b, uid, receipt, file, env, read } = watchdogFixture(t);
  writeFileSync(file, JSON.stringify(receipt)); assert.deepEqual(validateWatchdog(env, b, now, read), receipt);
  for (const [mutate, reason] of [
    [r => { r.state = 'expired'; }, 'watchdog-not-armed'], [r => { r.state = 'failed'; }, 'watchdog-not-armed'], [r => { r.format = 2; }, 'watchdog-not-armed'],
    [r => { r.heartbeatMs = now - 5001; }, 'watchdog-heartbeat-stale'], [r => { r.heartbeatMs = now + 1001; }, 'watchdog-heartbeat-future'],
    [r => { r.heartbeatMs = 'later'; }, 'watchdog-heartbeat-invalid'], [r => { r.heartbeatMs = now + 0.5; }, 'watchdog-heartbeat-invalid'],
    [r => { r.budgetHash = '0'.repeat(64); }, 'watchdog-budget-mismatch'], [r => { r.sourceHash = '0'.repeat(64); }, 'watchdog-source-mismatch'],
    [r => { r.start = 'reused'; }, 'watchdog-process-changed'], [r => { r.owner.start = 'reused'; }, 'watchdog-owner-changed'],
    [r => { r.extra = 'forbidden'; }, 'watchdog-receipt-invalid'], [r => { delete r.owner; }, 'watchdog-receipt-invalid']]) {
    const value = structuredClone(receipt); mutate(value); writeFileSync(file, JSON.stringify(value));
    const error = refusal(() => validateWatchdog(env, b, now, read));
    assert.equal(error.reason, reason, JSON.stringify(value)); assert.ok(reasons.includes(error.reason));
    assert.equal(error.message, 'Service budget validation failed.');
  }
  writeFileSync(file, JSON.stringify(receipt));
  assert.equal(refusal(() => validateWatchdog(env, b, now, () => null)).reason, 'watchdog-process-changed');
  assert.equal(refusal(() => validateWatchdog(env, b, now, pid => pid === receipt.owner.pid ? null : read(pid))).reason, 'watchdog-owner-changed');
  assert.equal(refusal(() => validateWatchdog(env, b, now, pid => pid === receipt.owner.pid ? { ...read(pid), command: 'bash' } : read(pid))).reason, 'watchdog-owner-changed');
  assert.equal(refusal(() => validateWatchdog(env, b, now, pid => { const p = read(pid); return p ? { ...p, uid: uid + 1 } : null; })).reason, 'watchdog-uid-mismatch');
  assert.equal(refusal(() => validateWatchdog(env, { ...b, runId: '101' }, now, read)).reason, 'watchdog-budget-mismatch');
  rmSync(file); assert.equal(refusal(() => validateWatchdog(env, b, now, read)).reason, 'watchdog-receipt-invalid');
  writeFileSync(file, '{not json'); assert.equal(refusal(() => validateWatchdog(env, b, now, read)).reason, 'watchdog-receipt-invalid');
});
test('a heartbeat stamped after the caller sampled now is accepted within 1 s, a forged future one is not, and staleness is unchanged', t => {
  const { now, b, receipt, file, env, read } = watchdogFixture(t);
  for (const [heartbeatMs, reason] of [[now + 1, null], [now + 1000, null], [now + 1001, 'watchdog-heartbeat-future'], [now - 5000, null], [now - 5001, 'watchdog-heartbeat-stale']]) {
    writeFileSync(file, JSON.stringify({ ...receipt, heartbeatMs }));
    if (reason) assert.equal(refusal(() => validateWatchdog(env, b, now, read)).reason, reason, String(heartbeatMs - now));
    else assert.equal(validateWatchdog(env, b, now, read).heartbeatMs, heartbeatMs);
  }
});
test('a live publisher racing the checker never trips the future-heartbeat clause', async t => {
  // loadBudget samples now, then reads files; a heartbeat published in that gap is newer than the sampled now.
  const { now, b, receipt, file, env, read } = watchdogFixture(t);
  writeFileSync(file, JSON.stringify(receipt));
  const publisher = child(t, `const fs = require('node:fs'); const r = ${JSON.stringify(receipt)}; const f = ${JSON.stringify(file)}; let n = 0;
    setInterval(() => { r.heartbeatMs = Date.now(); const t = f + '.tmp' + (n++ % 2); fs.writeFileSync(t, JSON.stringify(r)); fs.renameSync(t, f); }, 2);`);
  await waitFor(() => JSON.parse(readFileSync(file)).heartbeatMs > now + 20);
  let sawNewer = 0;
  for (let i = 0; i < 100; i++) {
    const sampled = Date.now(); while (Date.now() < sampled + 5) { /* the gap a slow read or a loaded runner opens */ }
    const seen = validateWatchdog(env, b, sampled, read); if (seen.heartbeatMs > sampled) sawNewer++;
  }
  assert.ok(sawNewer > 0, 'the publisher must have raced the sampled clock for this test to mean anything');
  publisher.process.kill('SIGKILL'); await publisher.exited;
});
test('a refusal prints only a closed-list reason code, never receipt, budget or environment values', t => {
  const { dir, now, b, receipt, file } = watchdogFixture(t);
  writeFileSync(join(dir, 'service-budget.json'), JSON.stringify(b));
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { loadBudget } from ${JSON.stringify(new URL('./service-deadline.mjs', import.meta.url).href)}; try { loadBudget(); } catch { process.exitCode = 1; }`],
  { env: { PATH: process.env.PATH, RUNNER_TEMP: dir, SERVICE_WATCHDOG_REQUIRED: '1', GITHUB_REPOSITORY: b.repository, GITHUB_RUN_ID: b.runId, GITHUB_RUN_ATTEMPT: b.attempt,
    SERVICE_HEAD_SHA: b.headSha, GITHUB_SHA: b.checkout, PRIVATE: 'PRIVATE_DO_NOT_SERIALIZE' }, encoding: 'utf8' });
  let result = run(); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Service budget refused: watchdog-receipt-invalid.\n');
  writeFileSync(file, JSON.stringify({ ...receipt, extra: 'PRIVATE_DO_NOT_SERIALIZE', heartbeatMs: now + 5000 }));
  result = run(); assert.equal(result.status, 1); assert.equal(result.stderr, 'Service budget refused: watchdog-receipt-invalid.\n');
  writeFileSync(file, JSON.stringify({ ...receipt, state: 'PRIVATE_DO_NOT_SERIALIZE' }));
  result = run(); assert.equal(result.stderr, 'Service budget refused: watchdog-not-armed.\n'); assert.doesNotMatch(result.stderr, /PRIVATE/);
  // A spent budget is named too; it is a fixed word, not the budget values.
  writeFileSync(join(dir, 'service-budget.json'), JSON.stringify({ ...b, deadlineMs: now - 1, startedMs: now - 1 - budgetMs }));
  result = run(); assert.equal(result.status, 1); assert.equal(result.stderr, 'Service budget refused: budget-expired.\n');
  // A guard without a reason code stays silent, so the closed list is the only thing that can reach the log.
  writeFileSync(join(dir, 'service-budget.json'), JSON.stringify({ ...b, runId: '999' }));
  result = run(); assert.equal(result.status, 1); assert.equal(result.stderr, '');
});
test('losing a required watchdog cannot fall back to fetching a fresh clock', async t => {
  const { initialize, root } = await import('./service-budget.mjs');
  const dir = temporaryFixture(t), checkout = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const b = { ...budget(Date.now() + 10000), checkout }; const file = join(dir, 'service-budget.json'); writeFileSync(file, JSON.stringify(b));
  const env = { RUNNER_TEMP: dir, SERVICE_WATCHDOG_REQUIRED: '1', GITHUB_REPOSITORY: b.repository, GITHUB_RUN_ID: b.runId, GITHUB_RUN_ATTEMPT: b.attempt,
    SERVICE_HEAD_SHA: b.headSha, GITHUB_SHA: checkout, GITHUB_OUTPUT: join(dir, 'outputs') };
  let requests = 0;
  await assert.rejects(() => initialize(env, async () => { requests++; throw new Error('must not fetch'); }));
  assert.equal(requests, 0); assert.deepEqual(JSON.parse(readFileSync(file)), b); assert.equal(existsSync(env.GITHUB_OUTPUT), false);
});
test('the first-step CLI refuses a workstation without credentials, source values or signals leaking', t => {
  const dir = temporaryFixture(t);
  const script = new URL('./service-deadline.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script, 'bootstrap'], { env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'outputs'), RUNNER_ENVIRONMENT: 'self-hosted', PRIVATE: 'PRIVATE_DO_NOT_SERIALIZE' }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Service deadline refused: hosted-environment-unsupported.\nService deadline supervision failed.\n');
  assert.doesNotMatch(result.stderr, /PRIVATE/); assert.deepEqual(readdirSync(dir), []);
});

// The arming step used to print one generic line for every refusal, so a run past its budget looked like a flake (2026-10-21).
const sha = 'a'.repeat(40), startedAt = '2026-10-20T04:37:18Z', startedAtMs = Date.parse(startedAt);
const armEnv = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', SERVICE_HEAD_SHA: sha, GITHUB_SHA: sha,
  GH_TOKEN: 'token', GITHUB_API_URL: 'https://api.github.com' };
const armRun = (changes = {}) => ({ id: 100, run_attempt: 1, head_sha: sha, repository: { full_name: 'owner/repo' }, run_started_at: startedAt, ...changes });
const answer = (run, ok = true) => async () => ({ ok, json: async () => run });
const reasonOf = fn => { try { fn(); } catch (error) { return error.reason ?? null; } return assert.fail('Expected a refusal.'); };
const reasonOfAsync = async fn => { try { await fn(); } catch (error) { return error.reason ?? null; } return assert.fail('Expected a refusal.'); };
test('the budget clauses each name their own reason, and a spent budget is told apart from an early clock', () => {
  const identity = identityFromEnv(armEnv), at = startedAtMs + 60_000;
  assert.equal(budgetFromRun(armRun(), identity, at).deadlineMs, startedAtMs + budgetMs);
  for (const [changes, reason] of [[{ id: 101 }, 'budget-run-mismatch'], [{ run_attempt: 2 }, 'budget-run-mismatch'], [{ head_sha: 'b'.repeat(40) }, 'budget-run-mismatch'],
    [{ repository: { full_name: 'other/repo' } }, 'budget-run-mismatch'], [{ run_started_at: '2026-10-20T04:37:18.000Z' }, 'budget-run-started-invalid'],
    [{ run_started_at: undefined }, 'budget-run-started-invalid']]) assert.equal(reasonOf(() => budgetFromRun(armRun(changes), identity, at)), reason, JSON.stringify(changes));
  assert.equal(reasonOf(() => identityFromEnv({ ...armEnv, GITHUB_RUN_ID: '0' })), 'budget-identity-invalid');
  // The boundary seen in the 2026-10-17 and 2026-10-20 runs: a job that starts after run start + 30 min cannot arm.
  assert.equal(reasonOf(() => budgetFromRun(armRun(), identity, startedAtMs + budgetMs)), 'budget-expired');
  assert.equal(reasonOf(() => budgetFromRun(armRun(), identity, startedAtMs + budgetMs + 33_000)), 'budget-expired');
  assert.equal(budgetFromRun(armRun(), identity, startedAtMs + budgetMs - 1).deadlineMs - (startedAtMs + budgetMs - 1), 1);
  assert.equal(reasonOf(() => budgetFromRun(armRun(), identity, startedAtMs - 1)), 'budget-not-started');
  const budget = { format: 1, ...identity, startedMs: startedAtMs, deadlineMs: startedAtMs + budgetMs };
  assert.equal(reasonOf(() => remainingMs({ ...budget, format: 2 }, at)), 'budget-invalid');
  assert.equal(reasonOf(() => remainingMs({ ...budget, deadlineMs: budget.deadlineMs + 1 }, at)), 'budget-invalid');
  assert.equal(reasonOf(() => remainingMs(budget, Number.NaN)), 'budget-invalid');
});
test('the budget request names whether it was refused before sending, unreachable, rejected or unreadable', async () => {
  const at = () => startedAtMs + 60_000;
  assert.equal((await requestBudget(armEnv, answer(armRun()), at)).startedMs, startedAtMs);
  for (const [env, request, reason] of [
    [{ ...armEnv, GH_TOKEN: undefined }, answer(armRun()), 'budget-request-invalid'],
    [{ ...armEnv, GITHUB_API_URL: 'https://example.invalid' }, answer(armRun()), 'budget-request-invalid'],
    [armEnv, async () => { throw new TypeError('PRIVATE_DO_NOT_SERIALIZE'); }, 'budget-api-unreachable'],
    [armEnv, async () => { throw new DOMException('PRIVATE_DO_NOT_SERIALIZE', 'TimeoutError'); }, 'budget-api-unreachable'],
    [armEnv, answer(armRun(), false), 'budget-api-refused'],
    [armEnv, async () => ({ ok: true, json: async () => { throw new SyntaxError('PRIVATE_DO_NOT_SERIALIZE'); } }), 'budget-api-response-invalid'],
    [armEnv, answer(armRun({ id: 7 })), 'budget-run-mismatch'],
  ]) {
    try { await requestBudget(env, request, at); assert.fail('Expected a refusal.'); }
    catch (error) { assert.equal(error.reason, reason); assert.ok(reasons.includes(error.reason)); assert.doesNotMatch(error.message, /PRIVATE/); }
  }
});
test('the hosted-owner check names an unsupported environment apart from a missing Runner.Worker', () => {
  const uid = 1000, hosted = { RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
  const worker = { pid: 50, ppid: 1, uid, start: '50', command: 'Runner.Worker' };
  const me = { pid: process.pid, ppid: 50, uid, start: '60', command: 'node' };
  assert.equal(hostedOwner(hosted, new Map([[50, worker], [process.pid, me]]), 'linux', uid), worker);
  assert.equal(reasonOf(() => hostedOwner(hosted, new Map(), 'darwin', uid)), 'hosted-environment-unsupported');
  assert.equal(reasonOf(() => hostedOwner({ ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, new Map(), 'linux', uid)), 'hosted-environment-unsupported');
  assert.equal(reasonOf(() => hostedOwner(hosted, new Map([[process.pid, { ...me, ppid: 1 }]]), 'linux', uid)), 'hosted-owner-missing');
  assert.equal(reasonOf(() => hostedOwner(hosted, new Map([[50, { ...worker, uid: uid + 1 }], [process.pid, me]]), 'linux', uid)), 'hosted-owner-missing');
});
test('bootstrap names what stopped it: a relative output path, a spent budget, or a watchdog that never armed', async t => {
  const dir = temporaryFixture(t), uid = process.getuid(), owner = () => ({ pid: 999999, ppid: 1, uid, start: 'owner', command: 'Runner.Worker' });
  const env = { ...armEnv, PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'outputs') };
  assert.equal(await reasonOfAsync(() => bootstrap({ ...env, GITHUB_OUTPUT: 'outputs' }, answer(armRun()), () => startedAtMs, owner)), 'output-path-invalid');
  assert.equal(await reasonOfAsync(() => bootstrap(env, answer(armRun()), () => startedAtMs + budgetMs + 5_000, owner)), 'budget-expired');
  assert.deepEqual(readdirSync(dir), []);
  // The child refuses on this machine (not a hosted Linux runner), so no receipt ever appears: the loop's own last clause is what is reported.
  // A fake clock that jumps keeps the 5 s wait short; nothing here sleeps for it.
  let ticks = 0; const clock = () => startedAtMs + 10_000 + 400 * ticks++;
  assert.equal(await reasonOfAsync(() => bootstrap(env, answer(armRun()), clock, owner)), 'watchdog-receipt-invalid');
  assert.equal(existsSync(env.GITHUB_OUTPUT), false);
  // No checker clause was ever seen (the window closes at the deadline before the first look): the generic name.
  // (The budget and ticket files are created once per directory, so this case gets its own.)
  const again = temporaryFixture(t), edgeEnv = { ...env, RUNNER_TEMP: again, GITHUB_OUTPUT: join(again, 'outputs') };
  const times = [startedAtMs + 10_000, startedAtMs + budgetMs - 1]; const edge = () => times.shift() ?? startedAtMs + budgetMs;
  assert.equal(await reasonOfAsync(() => bootstrap(edgeEnv, answer(armRun()), edge, owner)), 'watchdog-did-not-arm');
  assert.equal(existsSync(edgeEnv.GITHUB_OUTPUT), false);
});
test('every reason in the closed list is a fixed lowercase word and is asserted by name in this file', () => {
  const source = readFileSync(new URL('./service-deadline.test.mjs', import.meta.url), 'utf8');
  for (const reason of reasons) {
    assert.match(reason, /^[a-z]+(-[a-z]+)+$/);
    assert.ok(source.split(`'${reason}'`).length > 1, `${reason} needs a test that asserts it`);
  }
  assert.equal(new Set(reasons).size, reasons.length);
});
