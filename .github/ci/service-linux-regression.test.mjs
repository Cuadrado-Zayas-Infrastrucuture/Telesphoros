import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { budgetMs, hostedOwner, readProcess, readProcesses, selectNewProcesses, signalIdentity, terminateProcesses } from './service-deadline.mjs';
import { metricFiles, runProducer } from './service-evidence.mjs';
import { catalogueMetricControl } from './fixtures/catalogue.mjs';
import { recoveryMetricControl, applicationMetricControl } from './fixtures/recovery.mjs';

// These are file-backed identities with signal spies, distinct from the real test process.
const deniedPid = process.pid + 10, oldPid = process.pid + 11, ownerPid = process.pid + 12;

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'service-linux-regression-'));
  // Only this test's synthetic files are removed; no repository or service data is here.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function replaceFs(t, name, replacement) {
  const original = fs[name]; fs[name] = replacement(original); syncBuiltinESMExports();
  t.after(() => { fs[name] = original; syncBuiltinESMExports(); });
}
function procFixture(t) {
  const directory = fixture(t);
  const record = (pid, ppid = 1, command = 'mutable comm', executable = '/synthetic/node') => {
    fs.mkdirSync(join(directory, String(pid)));
    const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = String(ppid); fields[19] = String(pid * 10);
    fs.writeFileSync(join(directory, String(pid), 'stat'), `${pid} (${command}) ` + fields.join(' '));
    fs.symlinkSync(executable, join(directory, String(pid), 'exe'));
  };
  record(deniedPid, 1, 'Runner.Worker'); record(oldPid, 1, 'old'); record(ownerPid, 1, 'mutable', '/synthetic/Runner.Worker');
  record(process.pid, deniedPid);
  return { directory, exe: join(directory, String(deniedPid), 'exe'), read: pid => readProcess(pid, 'linux', directory) };
}
const hosted = { RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
for (const code of ['EACCES', 'EPERM', 'ENOENT', 'ESRCH']) {
  test(`Linux executable ${code} retains core identity without trusting mutable comm`, t => {
    const f = procFixture(t);
    replaceFs(t, 'readlinkSync', original => (path, ...args) => {
      if (String(path) === f.exe) throw Object.assign(new Error('synthetic executable denial'), { code });
      return original(path, ...args);
    });
    const table = readProcesses('linux', f.directory), p = table.get(deniedPid);
    assert.ok(p); assert.equal(p.pid, deniedPid); assert.equal(p.ppid, 1); assert.equal(p.start, String(deniedPid * 10));
    assert.equal(p.uid, process.getuid()); assert.equal(p.command, ''); assert.equal(table.size, 4);
    assert.throws(() => hostedOwner(hosted, table, 'linux', process.getuid()));
    table.get(process.pid).ppid = ownerPid;
    assert.equal(hostedOwner(hosted, table, 'linux', process.getuid()).pid, ownerPid);
  });
}
test('Linux core metadata denial and unexpected executable errors still fail closed', t => {
  const f = procFixture(t); let code = 'EIO';
  replaceFs(t, 'readlinkSync', original => (path, ...args) => {
    if (String(path) === f.exe) throw Object.assign(new Error('synthetic executable I/O failure'), { code });
    return original(path, ...args);
  });
  assert.throws(() => readProcesses('linux', f.directory), { code: 'EIO' }); code = 'EACCES';
  replaceFs(t, 'readFileSync', original => (path, ...args) => {
    if (String(path) === join(f.directory, String(oldPid), 'stat')) throw Object.assign(new Error('synthetic core denial'), { code: 'EACCES' });
    return original(path, ...args);
  });
  assert.throws(() => readProcesses('linux', f.directory), { code: 'EACCES' });
  assert.equal(f.read(999999999), null);
});
test('an unreadable executable cannot remove a detached cleanup target or bypass live identity checks', async t => {
  const f = procFixture(t);
  replaceFs(t, 'readlinkSync', original => (path, ...args) => {
    if (String(path) === f.exe) throw Object.assign(new Error('synthetic executable denial'), { code: 'EACCES' });
    return original(path, ...args);
  });
  const table = readProcesses('linux', f.directory), p = table.get(deniedPid);
  const baseline = new Map([...table].filter(([pid]) => pid !== deniedPid)); const calls = [];
  const selected = current => selectNewProcesses(current, baseline, process.getuid());
  assert.deepEqual(selected(table).map(p => p.pid), [deniedPid]);
  for (const changed of [{ ...p, start: 'reused' }, { ...p, uid: p.uid + 1 }])
    assert.equal(signalIdentity(changed, 'SIGKILL', { read: f.read, kill: () => assert.fail() }), false);
  await terminateProcesses(selected, { graceMs: 0, read: () => table, signal: (p, kind) => signalIdentity(p, kind, { read: f.read, kill: (...args) => calls.push(args) }) });
  for (const kind of ['SIGSTOP', 'SIGTERM', 'SIGCONT', 'SIGKILL']) assert.ok(calls.some(([pid, signal]) => pid === deniedPid && signal === kind));
});

const backendLog = 'PASS test/control.spec.ts (1 s)\nTest Suites: 1 passed, 1 total\nTests: 3 passed, 3 total\n';
function producerFixture(t) {
  const directory = fixture(t), cwd = join(directory, 'checkout'); fs.mkdirSync(cwd);
  const clock = Date.now(), identity = { repository: 'owner/repo', runId: '100', attempt: '1', headSha: 'a'.repeat(40), checkout: 'b'.repeat(40) };
  const budget = { format: 1, ...identity, startedMs: clock - 5000, deadlineMs: clock - 5000 + budgetMs };
  const env = { RUNNER_TEMP: directory, GITHUB_REPOSITORY: identity.repository, GITHUB_RUN_ID: identity.runId,
    GITHUB_RUN_ATTEMPT: identity.attempt, SERVICE_HEAD_SHA: identity.headSha, GITHUB_SHA: identity.checkout };
  const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n');
  json(join(directory, 'service-budget.json'), budget);
  json(join(directory, 'service-test-prerequisites.json'), { format: 1, phase: 'shared-library-build', libraries: ['shared-types','cpic-schema','fake-idp','jobs'], durationMs: 42, exitCode: 0, nodeVersion: '22.22.0' });
  const target = join(cwd, 'apps/backend/test-results'); fs.mkdirSync(target, { recursive: true });
  const files = metricFiles('memory').map(name => join(target, name));
  const produce = () => {
    fs.writeFileSync(join(cwd, 'tier1.log'), backendLog);
    for (const [i, file] of files.entries()) {
      const value = [catalogueMetricControl, recoveryMetricControl, applicationMetricControl][i](); value.runtime.gitHead = identity.checkout; json(file, value);
    }
  };
  return { directory, cwd, env, clock, budget, target, files, produce, completion: join(directory, 'service-profile-memory/completion.json') };
}
function coarseTimes(t, f, { older = false, wrongDevice = false } = {}) {
  const ns = BigInt(f.clock - 2) * 1000000n;
  replaceFs(t, 'lstatSync', original => (path, options) => {
    const info = original(path, options), name = String(path);
    if (f.files.includes(name) || name.includes('/.service-evidence-fence-')) {
      // Model one coarse filesystem tick, independent of the wall-clock sample.
      const metric = f.files.includes(name), time = older && metric ? ns - 1n : ns;
      Object.defineProperty(info, 'mtimeMs', { value: options?.bigint ? time / 1000000n : Number(time) / 1e6 });
      if (options?.bigint) Object.defineProperty(info, 'mtimeNs', { value: time });
      if (metric && wrongDevice) Object.defineProperty(info, 'dev', { value: options?.bigint ? info.dev + 1n : info.dev + 1 });
    }
    return info;
  });
}
test('new valid metrics within the same coarse filesystem tick seal without a wall-clock allowance', async t => {
  const f = producerFixture(t); coarseTimes(t, f);
  assert.equal(await runProducer('memory', 'synthetic', { env: f.env, cwd: f.cwd, now: () => f.clock, execute: async () => { f.produce(); return 0; } }), 0);
  assert.ok(fs.existsSync(f.completion)); assert.deepEqual(fs.readdirSync(f.target).sort(), metricFiles('memory').sort());
  const sealed = JSON.parse(fs.readFileSync(f.completion)); assert.deepEqual(sealed.budget, f.budget);
});
for (const kind of ['regular', 'symlink', 'dangling-symlink', 'directory']) {
  test(`pre-existing ${kind} metric refuses before the producer executes`, async t => {
    const f = producerFixture(t); let calls = 0;
    if (kind === 'regular') { f.produce(); for (const file of f.files) fs.utimesSync(file, (f.clock + 1000) / 1000, (f.clock + 1000) / 1000); }
    else if (kind === 'directory') fs.mkdirSync(f.files[0]);
    else fs.symlinkSync(kind === 'symlink' ? join(f.directory, 'service-budget.json') : join(f.directory, 'missing'), f.files[0]);
    await assert.rejects(() => runProducer('memory', 'synthetic', { env: f.env, cwd: f.cwd, now: () => f.clock, execute: async () => { calls++; f.produce(); return 0; } }));
    assert.equal(calls, 0); assert.equal(fs.existsSync(f.completion), false);
  });
}
for (const reason of ['older', 'device', 'native-failure', 'expired', 'invalid']) {
  test(`the filesystem fence cannot seal ${reason} output`, async t => {
    const f = producerFixture(t); coarseTimes(t, f, { older: reason === 'older', wrongDevice: reason === 'device' });
    let clock = f.clock;
    const result = () => runProducer('memory', 'synthetic', { env: f.env, cwd: f.cwd, now: () => clock, execute: async () => {
      f.produce();
      if (reason === 'expired') clock = f.budget.deadlineMs;
      if (reason === 'invalid') fs.writeFileSync(f.files[0], '{}');
      return reason === 'native-failure' ? 17 : 0;
    } });
    if (reason === 'native-failure') assert.equal(await result(), 17); else await assert.rejects(result);
    assert.equal(fs.existsSync(f.completion), false);
    assert.equal(fs.readdirSync(f.target).some(name => name.startsWith('.service-evidence-fence-')), false);
  });
}
test('failure reading the owned filesystem fence refuses before execution and removes its marker', async t => {
  const f = producerFixture(t); let calls = 0;
  replaceFs(t, 'lstatSync', original => (path, ...args) => {
    if (String(path).includes('/.service-evidence-fence-')) throw Object.assign(new Error('synthetic fence denial'), { code: 'EACCES' });
    return original(path, ...args);
  });
  await assert.rejects(() => runProducer('memory', 'synthetic', { env: f.env, cwd: f.cwd, execute: async () => { calls++; return 0; } }));
  assert.equal(calls, 0); assert.equal(fs.readdirSync(f.target).length, 0); assert.equal(fs.existsSync(f.completion), false);
});
