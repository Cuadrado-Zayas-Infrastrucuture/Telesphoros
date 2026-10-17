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
import { budgetMs, hostedOwner, parseLinuxProcess, processKey, readProcess, readProcesses, signalIdentity, watchJob, validateWatchdog } from './service-deadline.mjs';
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

test('watchdog receipts bind the live owner, process identity, source, clock and heartbeat', t => {
  const dir = temporaryFixture(t), now = Date.now(), b = budget(now + 10000), uid = process.getuid();
  const owner = { pid: 111111, ppid: 1, uid, start: 'owner-start', command: 'Runner.Worker' };
  const monitor = { pid: 222222, ppid: 1, uid, start: 'monitor-start', command: 'node' };
  const receipt = { format: 1, state: 'armed', pid: monitor.pid, start: monitor.start, owner, budgetHash: hash(JSON.stringify(b)), sourceHash: hash(readFileSync(new URL('./service-deadline.mjs', import.meta.url))), heartbeatMs: now };
  const file = join(dir, 'service-watchdog.json'), env = { RUNNER_TEMP: dir };
  const read = pid => pid === owner.pid ? owner : pid === monitor.pid ? monitor : null;
  writeFileSync(file, JSON.stringify(receipt)); assert.deepEqual(validateWatchdog(env, b, now, read), receipt);
  for (const mutate of [r => { r.state = 'expired'; }, r => { r.state = 'failed'; }, r => { r.heartbeatMs = now - 5001; }, r => { r.heartbeatMs = now + 1; },
    r => { r.budgetHash = '0'.repeat(64); }, r => { r.sourceHash = '0'.repeat(64); }, r => { r.start = 'reused'; }, r => { r.owner.start = 'reused'; }, r => { r.extra = 'forbidden'; }]) {
    const value = structuredClone(receipt); mutate(value); writeFileSync(file, JSON.stringify(value)); assert.throws(() => validateWatchdog(env, b, now, read));
  }
  writeFileSync(file, JSON.stringify(receipt)); assert.throws(() => validateWatchdog(env, b, now, () => null));
  assert.throws(() => validateWatchdog(env, b, now, pid => { const p = read(pid); return p ? { ...p, uid: uid + 1 } : null; }));
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
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'Service deadline supervision failed.\n');
  assert.deepEqual(readdirSync(dir), []);
});
